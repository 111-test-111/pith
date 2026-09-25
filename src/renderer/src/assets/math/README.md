Latin Modern Math, unchanged WOFF2 distributed by Temml:
https://github.com/ronkok/Temml/blob/main/site/assets/latinmodernmath.woff2

Upstream fonts: https://www.gust.org.pl/projects/e-foundry/lm-math
License: GUST Font License (see [the packaged license](../../../public/licenses/latin-modern-math.txt)).

Bundled instead of relying on an installed system math font, so formulas work
offline with the same glyphs on all Electron platforms. Loaded only with the
lazy math renderer. The small supplemental Temml font comes from its npm package.
