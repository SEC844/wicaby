# Wicaby brand

The mark is a rounded white W whose right arm flicks up into a blue play triangle. A narrow gap separates the two: the W is cut by the triangle's outline, which leaves a notch under the triangle and a straight cut parallel to its lower edge.

The files here build it as clean geometry rather than an auto-trace.

## Masters

| File | Use |
| --- | --- |
| `wicaby-mark.svg` | The mark for dark backgrounds: the W in `currentColor` (white by default) and the play in `#0a84ff`. |
| `wicaby-mark-mono.svg` | One colour (`currentColor`), with the gap kept. Use it for the sidebar and other monochrome contexts. |
| `wicaby-mark-small.svg` | Small cut for 16 to 24 px: the gap is about twice as wide (40 units instead of 19.5), the triangle is 12 % bigger and the stroke is a little heavier, so the gap still shows at 1 px. |
| `wicaby-app-icon.svg` | App icon for 48 px and up: graphite tile (`#1c1c1f` at the top to `#0b0b0d`), a faint top rim light and a transparent outside. It keeps the original framing (tile 64..960 of 1024, rx 170). |
| `wicaby-app-icon-small.svg` | App icon for 16 to 32 px: a full-bleed tile, no rim, and the small cut scaled up by 1.08. |
| `wicaby-wordmark.svg` | Lockup of the mark and "Wicaby" in Geist SemiBold, outlined. The cap height is 0.6 × the W's body height, centred on the body. The text takes `currentColor`. |
| `android/` | Android launcher, TV banner and notification resources. See `android/README.md`. |

## Geometry

Everything is built in the 1024-unit app-icon space by `brand/scripts/make-brand.mjs`. The positions were fitted to the original 1254 px tile. The output is plain path data made of lines and circular arcs, with no strokes or masks, so it works the same way in SVG and in Android vector drawables.

- **W.** The W follows a polyline: P1 (245.5, 432), P2 (367, 667), P3 (516.5, 436.5), P4 (637, 668.5), P5 (759, 459.5).
  - Arms 1 to 3 have a half-width of 65 units. The outer joins and the left terminal are round, and the inner crotches are sharp.
  - The right arm tapers from 65 at P4 to 53.5 at P5, so it narrows into the play.
- **Play.** The play glyph is an equilateral-ish triangle: a vertical left edge at x 732.5 from y 334 to 443, and the tip at (828, 388.5). It is offset by its corner radius of 25.
- **Gap.** The gap is 19.5 units along the triangle's lower edge. Under the triangle's bottom-left corner, the notch radius is 42.5, slightly tighter than 25 + 19.5, so the gap opens up a little there, as in the drawing. The tip of the right arm has an 11-unit fillet.

## In the app and the build

- **Renderer.** Use `apps/desktop/src/renderer/components/Logo.svelte`: `<Logo size={…} />` for the blue play, or `<Logo size={…} mono />` for a single colour. `size` is a square box with the mark centred in it, and the component switches to the small cut at 24 px and below.
- **Desktop icons.** `npm run icon` (`brand/scripts/make-icon.mjs`) rasterises the SVGs with the project's Electron and writes:
  - `apps/desktop/resources/icon.ico` (16, 24 and 32 from the small cut; 48, 64, 128 and 256 from the regular one);
  - `apps/desktop/resources/icon.png` (512);
  - the Android legacy mipmaps, in `apps/android/tv/src/main/res/mipmap-*dpi/`.

To change the mark, edit the geometry in `brand/scripts/make-brand.mjs` and run it. Then paste the printed paths (`node brand/scripts/make-brand.mjs --logo`) into `Logo.svelte`, and run `npm run icon`. Both scripts write the Android resources straight into `apps/android/tv` and `apps/android/mobile` (see `android/README.md`).
