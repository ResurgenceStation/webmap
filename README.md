# webmap

Interactive map viewer for HippieStation. Served at https://webmap.owo.fm.

It is a small static site (Leaflet + vanilla JS, no build step) that reads
the rendered tile pyramid and per-z object index from
https://tiles.owo.fm/hippiestation and shows:

- pan / zoom / z-level switching,
- hover tooltips with each object's name and description,
- click-to-pin objects into a sidebar,
- text search across every z-level,
- category layer filters (mobs, machines, structures, items, cables/pipes,
  turfs, areas).

The tile pyramid and the `objects.json` it consumes are produced by the
webmap-renderer in the
[ResurgenceStation](https://github.com/ResurgenceStation/ResurgenceStation)
repo (`docker/webmap/`). See `docker/webmap-site/Dockerfile` there for how
this repo is bundled and deployed.

## Files

- `index.html` — page layout, top bar, sidebar, map container.
- `main.js` — Leaflet bootstrap, hover lookup, pin/search/filter logic.
- `style.css` — dark theme.

Leaflet itself is fetched at deploy time and is not vendored in this repo.

## Local preview

You can open `index.html` directly in a browser; it reads
`https://tiles.owo.fm/hippiestation` for tiles and metadata. To point it at
a different tile host, edit the `<meta name="webmap:tiles-base">` value in
`index.html`.

## License

GPL-3.0, matching the parent project.
