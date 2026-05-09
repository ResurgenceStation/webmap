/* HippieStation webmap — interactive Leaflet UI.
 *
 * Reads from $TILES_BASE (set via the <meta name="webmap:tiles-base"> tag):
 *   manifest.json                  — z-level catalogue + viewer constants
 *   <z>/<zoom>/<x>/<y>.png         — raster tile pyramid (Leaflet CRS.Simple)
 *   <z>/objects.json               — BYOND-coord-keyed metadata
 *
 * Hover lookup converts mouse pixel coords to BYOND (x,y) using
 * manifest.px_per_byond_tile, then hashes into objects.json.tiles.  The
 * pyramid (zoom/x/y) plays no role in object identity.
 */
(() => {
"use strict";

const TILES_BASE = document.querySelector('meta[name="webmap:tiles-base"]').content
    .replace(/\/+$/, "");

const TILE_PX = 256;            // matches docker/webmap/tile.py TILE_SIZE
const TOOLTIP_MAX_ENTRIES = 8;  // truncate stacked-object lists

// ─── DOM handles ────────────────────────────────────────────────────────────
const $map        = document.getElementById("map");
const $zSelect    = document.getElementById("z-select");
const $search     = document.getElementById("search-input");
const $status     = document.getElementById("status");
const $filters    = document.getElementById("layer-filters");
const $pinnedList = document.getElementById("pinned-list");
const $resultsPanel = document.getElementById("search-results-panel");
const $resultsList  = document.getElementById("search-results");

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
    manifest: null,
    map: null,
    tileLayer: null,
    currentZ: null,
    objectsByZ: {},          // {z: {tiles, byond_width, byond_height}}
    enabledCats: new Set(),  // category names currently visible
    pinned: [],              // [{x, y, z, entries}]
    hoverTip: null,
};

// Categories must match extract_objects.py CATEGORY_RULES; "other" is a
// catch-all for anything not in the named buckets.
const CATEGORIES = [
    "mobs", "machines", "structures", "items", "cables-pipes",
    "turfs", "areas", "other",
];

// ─── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
    setStatus("loading manifest…");
    try {
        const res = await fetch(`${TILES_BASE}/manifest.json`, { cache: "no-cache" });
        if (!res.ok) throw new Error(`manifest.json HTTP ${res.status}`);
        state.manifest = await res.json();
    } catch (err) {
        setStatus(`failed to load manifest: ${err.message}`);
        return;
    }

    populateZSelect();
    populateLayerFilters();

    // Initial z-level: the first one in the manifest.
    const firstZ = state.manifest.z_levels[0]?.id;
    if (firstZ == null) {
        setStatus("manifest contains no z-levels");
        return;
    }
    initLeaflet();
    await switchZ(firstZ);

    $zSelect.addEventListener("change", () => switchZ(parseInt($zSelect.value, 10)));
    $search.addEventListener("input", onSearch);
    setStatus("ready");
}

function setStatus(msg) { $status.textContent = msg; }

function populateZSelect() {
    $zSelect.innerHTML = "";
    for (const zl of state.manifest.z_levels) {
        const opt = document.createElement("option");
        opt.value = zl.id;
        opt.textContent = `${zl.id}: ${zl.name}`;
        $zSelect.appendChild(opt);
    }
}

function populateLayerFilters() {
    $filters.innerHTML = "";
    for (const cat of CATEGORIES) {
        const id = `cat-${cat}`;
        const wrapper = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = id;
        cb.value = cat;
        // Default-on except turfs/areas (visually noisy in tooltips).
        cb.checked = !(cat === "turfs" || cat === "areas");
        if (cb.checked) state.enabledCats.add(cat);
        cb.addEventListener("change", () => {
            if (cb.checked) state.enabledCats.add(cat);
            else state.enabledCats.delete(cat);
            // Refresh in-flight UI that depends on the filter set.
            if ($search.value) onSearch();
        });
        wrapper.appendChild(cb);
        wrapper.appendChild(document.createTextNode(" " + cat));
        $filters.appendChild(wrapper);
    }
}

// ─── Leaflet init ───────────────────────────────────────────────────────────
//
// CRS.Simple. Tile pyramid is always padded to a 256-multiple at the source,
// so 1 latlng unit at zoom 0 == 1 BYOND tile == 1 pixel at zoom 0 == 32
// source pixels at zoom 5. This matches slimbus's working webmap so the same
// layer math (tg2leaf: lat = y - 255, lng = x) is reusable.
//
//   bounds:    [[-256, 0], [0, 256]]
//   maxNative: 5   (pyramid stops here)
//   max:       7   (Leaflet upscales for close zoom, no extra fetches)
const TILE_BOUNDS = [[-256, 0], [0, 256]];

function initLeaflet() {
    state.map = L.map($map, {
        crs: L.CRS.Simple,
        minZoom: 0,
        maxZoom: 9,
        maxBounds: [[-300, -50], [50, 305]],
        attributionControl: false,
        preferCanvas: true,
    });

    state.map.setView([-128, 128], 2);
    state.map.on("mousemove", onMouseMove);
    state.map.on("click",     onMapClick);
    state.map.on("move zoom", updateParallax);
    updateParallax();
}

// ─── Parallax: pan the per-z background layers at varying speeds ───────────
//
// Order matches the CSS background-image stack (front to back):
//   0: layer3, 1: galaxy, 2: galaxy3, 3: asteroids, 4: space_gas,
//   5: planet, 6: layer2, 7: layer1
//
// Speed is the fraction of the map pan a layer reflects. Real game speeds
// from code/_onclick/hud/parallax.dm: layer1=0.6, layer2=1.0, layer3=1.4,
// random=3, galaxy=1, planet=3. We compress them so even the fastest
// (closest) layer moves slower than the map content (closer-than-the-map
// would feel wrong), and divide the slowest down so distant stars feel
// almost stationary.
const PARALLAX_SPEEDS = [
    0.55, // layer3   - close stars
    0.10, // galaxy   - very far
    0.10, // galaxy3  - very far
    0.30, // asteroids - mid-distance, less prominent than close stars
    0.22, // space_gas (nebula) - distant gas
    0.18, // planet
    0.40, // layer2
    0.25, // layer1   - deepest stars
];

// Anchor positions for the no-repeat layers (galaxy, galaxy3, planet)
// so they sit at scenic spots when the map is centred.
const PARALLAX_BASES = [
    [0, 0],          // layer3
    [-340, -180],    // galaxy
    [380, 220],      // galaxy3
    [0, 0],          // asteroids
    [0, 0],          // space_gas
    [220, -160],     // planet
    [0, 0],          // layer2
    [0, 0],          // layer1
];

function updateParallax() {
    if (!state.map) return;
    // Internal API but stable across Leaflet 1.x: pixel offset of the map
    // pane relative to the container. Negative as the user pans content
    // toward positive screen coords.
    const pos = state.map._getMapPanePos();
    const parts = PARALLAX_SPEEDS.map((s, i) => {
        const x = PARALLAX_BASES[i][0] + pos.x * s;
        const y = PARALLAX_BASES[i][1] + pos.y * s;
        return `${x.toFixed(0)}px ${y.toFixed(0)}px`;
    });
    $map.style.backgroundPosition = parts.join(", ");
}

function buildTileLayer(z) {
    return L.tileLayer(`${TILES_BASE}/${z}/{z}/{x}/{y}.png`, {
        bounds: TILE_BOUNDS,
        tileSize: TILE_PX,
        minZoom: 0,
        maxZoom: 9,
        maxNativeZoom: 5,
        noWrap: true,
        tms: false,
    });
}

async function switchZ(z) {
    setStatus(`switching to z=${z}…`);
    state.currentZ = z;
    $zSelect.value = z;

    // Tag body so CSS can swap the under-map background per environment
    // (stars for station/centcom, lava glow for lavaland).
    const zlName = (state.manifest.z_levels.find(x => x.id === z) || {}).name || "";
    document.body.dataset.zname = zlName.toLowerCase();

    // Swap raster layer.
    if (state.tileLayer) state.map.removeLayer(state.tileLayer);
    state.tileLayer = buildTileLayer(z);
    state.tileLayer.addTo(state.map);

    const zl = state.manifest.z_levels.find(x => x.id === z);

    // Lazy-load objects.json for this z if we haven't seen it yet.
    if (!state.objectsByZ[z]) {
        try {
            const res = await fetch(`${TILES_BASE}/${z}/objects.json`, { cache: "no-cache" });
            if (res.ok) {
                state.objectsByZ[z] = await res.json();
            } else {
                state.objectsByZ[z] = { tiles: {}, byond_width: zl.byond_width, byond_height: zl.byond_height };
                console.warn(`objects.json for z=${z}: HTTP ${res.status}`);
            }
        } catch (err) {
            state.objectsByZ[z] = { tiles: {}, byond_width: zl.byond_width, byond_height: zl.byond_height };
            console.warn(`objects.json for z=${z} failed:`, err);
        }
    }

    setStatus(`z=${z} (${zl.name}) ready`);
}

// ─── latlng → BYOND tile ────────────────────────────────────────────────────
//
// Slimbus's tg2leaf draws BYOND tile (x, y) as a polygon with corners at
// (lng=x, lat=y-255) and (lng=x-1, lat=y-1-255). So the tile occupies
// lng [x-1, x] and lat [y-1-255, y-255]. Inverse:
//   x = floor(lng) + 1
//   y = floor(lat) + byond_height + 1
function latlngToByond(latlng) {
    const zl = state.manifest.z_levels.find(x => x.id === state.currentZ);
    const tx = Math.floor(latlng.lng) + 1;
    const ty = Math.floor(latlng.lat) + zl.byond_height + 1;
    if (tx < 1 || tx > zl.byond_width) return null;
    if (ty < 1 || ty > zl.byond_height) return null;
    return { x: tx, y: ty };
}

function entriesAt(z, x, y) {
    const data = state.objectsByZ[z];
    if (!data) return [];
    return data.tiles[`${x},${y}`] || [];
}

function visibleEntries(entries) {
    return entries.filter(e => state.enabledCats.has(e.category));
}

// ─── Hover ─────────────────────────────────────────────────────────────────
let pendingMove = null;
function onMouseMove(e) {
    pendingMove = e;
    if (pendingMove._scheduled) return;
    pendingMove._scheduled = true;
    requestAnimationFrame(() => {
        const ev = pendingMove;
        pendingMove = null;
        renderHover(ev);
    });
}

function renderHover(e) {
    const tile = latlngToByond(e.latlng);
    if (!tile) {
        if (state.hoverTip) state.hoverTip.remove();
        state.hoverTip = null;
        return;
    }
    const entries = visibleEntries(entriesAt(state.currentZ, tile.x, tile.y));
    if (!entries.length) {
        if (state.hoverTip) state.hoverTip.remove();
        state.hoverTip = null;
        return;
    }
    const html = renderTooltipHTML(tile, entries);
    if (!state.hoverTip) {
        state.hoverTip = L.tooltip({
            className: "webmap-tip",
            direction: "right",
            offset: L.point(12, 0),
            sticky: true,
            opacity: 1,
        }).setLatLng(e.latlng).setContent(html).addTo(state.map);
    } else {
        state.hoverTip.setLatLng(e.latlng).setContent(html);
    }
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g,
        c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// Collapse runs of identical type+name+desc entries into {entry, count}.
// SS13 maps frequently stack 2-3 of the same decal/cable on one tile.
function dedupeEntries(entries) {
    const out = [];
    for (const e of entries) {
        const key = `${e.type}\0${e.name || ""}\0${e.desc || ""}`;
        const last = out[out.length - 1];
        if (last && last._key === key) {
            last.count++;
        } else {
            out.push({ ...e, count: 1, _key: key });
        }
    }
    return out;
}

function renderTooltipHTML(tile, entries) {
    const collapsed = dedupeEntries(entries);
    const truncated = collapsed.length > TOOLTIP_MAX_ENTRIES;
    const rows = collapsed.slice(0, TOOLTIP_MAX_ENTRIES).map(e => {
        const hasName = !!e.name;
        const headline = hasName ? escapeHtml(e.name) : escapeHtml(e.type);
        // If we're using the type as the headline, don't show it again below.
        const typeLine = hasName ? `<div class="entry-type">${escapeHtml(e.type)}</div>` : "";
        const countTag = e.count > 1 ? ` <span class="entry-count">×${e.count}</span>` : "";
        return `
        <div class="tip-entry">
            <span class="entry-name">${headline}</span><span class="entry-cat">${escapeHtml(e.category)}</span>${countTag}
            ${e.desc ? `<div class="entry-desc">${escapeHtml(e.desc)}</div>` : ""}
            ${typeLine}
        </div>`;
    }).join("");
    const more = truncated ? `<div class="tip-coord">+${collapsed.length - TOOLTIP_MAX_ENTRIES} more…</div>` : "";
    return `<div class="tip-coord">(${tile.x}, ${tile.y}, ${state.currentZ})</div>${rows}${more}`;
}

// ─── Click-to-pin ──────────────────────────────────────────────────────────
function onMapClick(e) {
    const tile = latlngToByond(e.latlng);
    if (!tile) return;
    const entries = visibleEntries(entriesAt(state.currentZ, tile.x, tile.y));
    if (!entries.length) return;
    pin({ x: tile.x, y: tile.y, z: state.currentZ, entries });
}

function pin(p) {
    const dupIdx = state.pinned.findIndex(q => q.x === p.x && q.y === p.y && q.z === p.z);
    if (dupIdx >= 0) {
        state.pinned.splice(dupIdx, 1);
    }
    state.pinned.unshift(p);
    if (state.pinned.length > 32) state.pinned.length = 32;
    renderPinned();
}

function renderPinned() {
    $pinnedList.innerHTML = "";
    state.pinned.forEach((p, i) => {
        const li = document.createElement("li");
        li.innerHTML = `
            <button class="pin-remove" title="Unpin" data-idx="${i}">✕</button>
            <span class="entry-name">${escapeHtml(p.entries[0].name) || escapeHtml(p.entries[0].type)}</span>
            <span class="entry-coord">(${p.x},${p.y},${p.z})</span>
            ${p.entries.slice(0, 6).map(e => `
                <div class="tip-entry">
                    <span class="entry-name">${escapeHtml(e.name) || escapeHtml(e.type)}</span>
                    <span class="entry-cat">${escapeHtml(e.category)}</span>
                    ${e.desc ? `<div class="entry-desc">${escapeHtml(e.desc)}</div>` : ""}
                    <div class="entry-type">${escapeHtml(e.type)}</div>
                </div>
            `).join("")}
            ${p.entries.length > 6 ? `<div class="entry-coord">+${p.entries.length - 6} more on this tile</div>` : ""}
        `;
        $pinnedList.appendChild(li);
    });
    $pinnedList.querySelectorAll(".pin-remove").forEach(btn => {
        btn.addEventListener("click", () => {
            const i = parseInt(btn.dataset.idx, 10);
            state.pinned.splice(i, 1);
            renderPinned();
        });
    });
}

// ─── Search ────────────────────────────────────────────────────────────────
async function onSearch() {
    const query = $search.value.trim().toLowerCase();
    if (query.length < 2) {
        $resultsPanel.hidden = true;
        $resultsList.innerHTML = "";
        return;
    }

    // Lazy-load every z-level so search is global.
    for (const zl of state.manifest.z_levels) {
        if (state.objectsByZ[zl.id]) continue;
        try {
            const res = await fetch(`${TILES_BASE}/${zl.id}/objects.json`, { cache: "force-cache" });
            if (res.ok) state.objectsByZ[zl.id] = await res.json();
        } catch (_) { /* ignore */ }
    }

    const hits = [];
    for (const zl of state.manifest.z_levels) {
        const data = state.objectsByZ[zl.id];
        if (!data) continue;
        for (const [coord, entries] of Object.entries(data.tiles)) {
            for (const e of entries) {
                if (!state.enabledCats.has(e.category)) continue;
                const hay = (e.name || "") + " " + (e.desc || "");
                if (hay.toLowerCase().includes(query)) {
                    const [sx, sy] = coord.split(",");
                    hits.push({ z: zl.id, x: parseInt(sx, 10), y: parseInt(sy, 10), entry: e });
                    if (hits.length >= 200) break;
                }
            }
            if (hits.length >= 200) break;
        }
        if (hits.length >= 200) break;
    }

    $resultsPanel.hidden = hits.length === 0;
    $resultsList.innerHTML = "";
    hits.forEach((h, i) => {
        const li = document.createElement("li");
        li.innerHTML = `
            <button class="result-jump" data-idx="${i}" title="Jump to tile">→</button>
            <span class="entry-name">${escapeHtml(h.entry.name) || escapeHtml(h.entry.type)}</span>
            <span class="entry-coord">(${h.x},${h.y},${h.z})</span>
            <span class="entry-cat">${escapeHtml(h.entry.category)}</span>
            ${h.entry.desc ? `<div class="entry-desc">${escapeHtml(h.entry.desc)}</div>` : ""}
            <div class="entry-type">${escapeHtml(h.entry.type)}</div>
        `;
        $resultsList.appendChild(li);
    });
    $resultsList.querySelectorAll(".result-jump").forEach(btn => {
        btn.addEventListener("click", async () => {
            const h = hits[parseInt(btn.dataset.idx, 10)];
            await jumpTo(h.z, h.x, h.y);
        });
    });
}

async function jumpTo(z, x, y) {
    if (z !== state.currentZ) await switchZ(z);
    const zl = state.manifest.z_levels.find(zz => zz.id === z);
    // Tile (x, y) covers lng [x-1, x] and lat [y-1-byond_height, y-byond_height].
    // Centre = (x - 0.5, y - byond_height - 0.5).
    const lat = (y - zl.byond_height) - 0.5;
    const lng = x - 0.5;
    state.map.setView([lat, lng], 6);
    pin({ x, y, z, entries: visibleEntries(entriesAt(z, x, y)) });
}

// ─── Go ─────────────────────────────────────────────────────────────────────
init();

})();
