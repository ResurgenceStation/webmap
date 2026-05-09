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
    initLeaflet(firstZ);
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
// CRS.Simple maps "map space" 1:1 to Leaflet LatLng. We set up the bounds so
// the rendered map's top-left is (0, 0) and bottom-right is (-h_px, w_px) in
// (lat, lng). That gives us:
//   lng  = pixel x   from the left
//   -lat = pixel y   from the top
// which is exactly what tile.py emits and exactly what we need to invert into
// BYOND tile coords on hover.
function initLeaflet(z) {
    const zl = state.manifest.z_levels.find(x => x.id === z);
    const wPx = zl.byond_width  * state.manifest.px_per_byond_tile;
    const hPx = zl.byond_height * state.manifest.px_per_byond_tile;

    state.map = L.map($map, {
        crs: L.CRS.Simple,
        minZoom: state.manifest.min_zoom ?? 0,
        maxZoom: state.manifest.max_zoom ?? 5,
        zoomSnap: 0.25,
        attributionControl: false,
    });

    state.map.fitBounds([[-hPx, 0], [0, wPx]]);
    state.map.on("mousemove", onMouseMove);
    state.map.on("click",     onMapClick);
    // Throttle by latching the most recent mousemove and processing on rAF.
}

function buildTileLayer(z) {
    const zl = state.manifest.z_levels.find(x => x.id === z);
    const wPx = zl.byond_width  * state.manifest.px_per_byond_tile;
    const hPx = zl.byond_height * state.manifest.px_per_byond_tile;

    return L.tileLayer(`${TILES_BASE}/${z}/{z}/{x}/{y}.png`, {
        bounds: [[-hPx, 0], [0, wPx]],
        tileSize: TILE_PX,
        minZoom: state.manifest.min_zoom ?? 0,
        maxZoom: state.manifest.max_zoom ?? 5,
        noWrap: true,
        errorTileUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    });
}

async function switchZ(z) {
    setStatus(`switching to z=${z}…`);
    state.currentZ = z;
    $zSelect.value = z;

    // Swap raster layer.
    if (state.tileLayer) state.map.removeLayer(state.tileLayer);
    state.tileLayer = buildTileLayer(z);
    state.tileLayer.addTo(state.map);

    // Re-fit bounds for the new z (z-levels can have different sizes).
    const zl = state.manifest.z_levels.find(x => x.id === z);
    const wPx = zl.byond_width  * state.manifest.px_per_byond_tile;
    const hPx = zl.byond_height * state.manifest.px_per_byond_tile;
    state.map.fitBounds([[-hPx, 0], [0, wPx]]);

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

// ─── Pixel → BYOND tile translation ────────────────────────────────────────
//
// L.CRS.Simple gives us latlng in map-pixel units; we set bounds [[-h,0],[0,w]]
// so x = lng, y = -lat. BYOND is 1-indexed and y points north (highest y is at
// the top of the rendered PNG, since dmm-tools emits north-up).
function latlngToByond(latlng) {
    const ppt = state.manifest.px_per_byond_tile;
    const zl = state.manifest.z_levels.find(x => x.id === state.currentZ);

    const px_x = latlng.lng;
    const px_y = -latlng.lat;
    const tx = Math.floor(px_x / ppt) + 1;
    const ty_from_top = Math.floor(px_y / ppt);
    const ty = zl.byond_height - ty_from_top;

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

function renderTooltipHTML(tile, entries) {
    const truncated = entries.length > TOOLTIP_MAX_ENTRIES;
    const rows = entries.slice(0, TOOLTIP_MAX_ENTRIES).map(e => `
        <div class="tip-entry">
            <span class="entry-name">${escapeHtml(e.name) || escapeHtml(e.type)}</span>
            <span class="entry-cat">${escapeHtml(e.category)}</span>
            ${e.desc ? `<div class="entry-desc">${escapeHtml(e.desc)}</div>` : ""}
            <div class="entry-type">${escapeHtml(e.type)}</div>
        </div>
    `).join("");
    const more = truncated ? `<div class="tip-coord">+${entries.length - TOOLTIP_MAX_ENTRIES} more…</div>` : "";
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
    const ppt = state.manifest.px_per_byond_tile;
    const zl = state.manifest.z_levels.find(zz => zz.id === z);
    // Centre the BYOND tile in the viewport.
    const px_x = (x - 0.5) * ppt;
    const px_y_from_top = (zl.byond_height - y + 0.5) * ppt;
    state.map.setView([-px_y_from_top, px_x], state.manifest.max_zoom ?? 5);
    pin({ x, y, z, entries: visibleEntries(entriesAt(z, x, y)) });
}

// ─── Go ─────────────────────────────────────────────────────────────────────
init();

})();
