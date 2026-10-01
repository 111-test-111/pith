# Math fonts

Offline math rendering uses an unchanged Latin Modern Math WOFF2 in [assets/math](../src/renderer/src/assets/math/). The renderer, Temml CSS and fonts load on demand without relying on system fonts. Temml supplies its supplemental font through its npm package.

- Distribution source: [Temml font](https://github.com/ronkok/Temml/blob/main/site/assets/latinmodernmath.woff2).
- Upstream: [GUST Latin Modern Math](https://www.gust.org.pl/projects/e-foundry/lm-math).
- License: GUST Font License; the [original license](../src/renderer/public/licenses/latin-modern-math.txt) ships with the renderer and remains separate from the project's MIT license.

Run `node scripts/check-markdown-math.mjs` after changing Markdown or math rendering. Fonts are source assets and survive build cleanup.
