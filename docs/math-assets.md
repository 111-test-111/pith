# Math fonts

Offline math rendering uses a bundled TeX Gyre DejaVu Math WOFF2 in [assets/math](../src/renderer/src/assets/math/), registered as `Pith Math` in [lib/math.css](../src/renderer/src/lib/math.css). The renderer, Temml CSS and fonts load on demand without relying on system fonts, so formulas follow the app's bundled face rather than whatever the user has installed and stay consistent across systems; platform text shaping can still produce minor differences. Temml supplies its supplemental font through its npm package.

- Bundled file: `texgyredejavu-math.woff2`, the upstream `texgyredejavu-math.otf` (version 1.106) copied in and re-encoded as WOFF2 — a lossless container change: MATH, CFF, cmap, GPOS/GSUB and glyph order stay byte-identical after decoding.
- Upstream: [GUST TeX Gyre Math](https://www.gust.org.pl/projects/e-foundry/tex-gyre-math).
- License: GUST Font License plus the Bitstream/DejaVu notice; the [original license](../src/renderer/public/licenses/tex-gyre-dejavu-math.txt) ships with the renderer and remains separate from the project's MIT license.

To refresh the bundled file from a local copy (a TeX Live tree or a system font install), the OTF re-encodes with fontTools and no table changes:

```sh
python3 -c "from fontTools.ttLib import TTFont; f = TTFont('texgyredejavu-math.otf'); f.flavor = 'woff2'; f.save('texgyredejavu-math.woff2')"
```

Run `node scripts/check-markdown-math.mjs` after changing Markdown or math rendering. Fonts are source assets and survive build cleanup.
