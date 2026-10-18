# Wicaby design system: "Graphite"

Wicaby looks and moves like an Apple app (tvOS / macOS Sonoma / Apple TV app) built on Windows 11. It is sleek, quiet and content-first. The posters and artwork are the colour; the chrome is neutral graphite plus one accent.

Colour tokens have one source, `packages/tokens/tokens.json`. `node packages/tokens/build.mjs` writes them to `apps/desktop/src/renderer/tokens.css` and to `Tokens.kt` in `apps/android/core` (the TV `C`, the mobile `G` and the mesh and Live TV panels read it), and `tools/checks/tokens-check.mjs` fails when those files are stale. Type, motion, shape and layout tokens live in `apps/desktop/src/renderer/app.css`. The TV draws focus as an inverted pair (`TvFocus.bg` white, `TvFocus.fg` black).

## Themes

Every app uses the same theme ids (desktop `ui.theme`, Android `Prefs.theme` on mobile and `TvSettings.theme` on the TV). Each theme in `tokens.json` sets the same roles; the generator writes one full `[data-theme='id']` block per theme to `tokens.css` and one `Tokens.Palette` per theme to `Tokens.kt`.

| Id | Name (FR / EN) | Idea | Apps |
|---|---|---|---|
| `graphite` | Graphite | Neutral near-black, the default everywhere. Mica on Windows 11. | all |
| `oled` | OLED | Pure black canvas, darker surfaces. | all |
| `slate` | Ardoise / Slate | Graphite with a slight cool cast in canvas, fills and labels. | all |
| `cinema` | Cinéma / Cinema | Warm, low-blue chrome for evening viewing; artwork is untouched. | all |
| `contrast` | Contraste élevé / High Contrast | Black canvas, stronger fills and separators, readable tertiary text, opaque materials (no blur), Apple's accessible system colours with black text on the accent. | all |
| `light` | Clair / Light | Apple-style light chrome, Mica light on Windows 11. | desktop, mobile |
| `system` | Automatique / Automatic | Follows the OS between `light` and `graphite`. Not a palette. | desktop, mobile |

- **Graphite stays the default.** The TV hides `light` (a synced or unknown id reads as graphite) and suggests OLED or Cinéma once on Home (`ThemeHint`); picking a theme in Réglages, clicking one in the setup or leaving the setup's look step on a theme other than Graphite hides the suggestion (focusing a card there only previews it). Choosing in the hint moves focus to the row below first.
- **Contrast.** `tools/checks/contrast-check.mjs` computes WCAG 2.2 ratios for every theme and fails below 4.5:1 for `label` and `label-2` on `bg`, `bg-elevated`, `bg-elevated-2`, the materials and a hovered card, and below 3:1 for the text on a filled accent control (semibold, the large tier) and for the accent against the canvas and cards. Non-text (WCAG 1.4.11): `control`, the off track of a switch and the track of a slider, is 3:1 on the light canvas (its white knob carries it on dark themes); in `contrast` the `separator` is 3:1 and outlines fields, segmented controls, the search field, guide cells and settings groups, and focus adds a 2px neutral ring offset by 2px. `label-3` and `label-4` are for placeholders, disabled controls and decoration only.
- **Accents.** Each accent names a system colour, so every theme supplies its own tone (darker in `light`, Apple's accessible ones in `contrast`) and its own text colour on it (`accent-fg` overrides). Android mobile 12+ adds a ninth choice, Fond d'écran / Wallpaper (`ACCENT_SYSTEM`): the wallpaper's `primary` and `onPrimary` (Material You), never its surfaces, and blue when it is under 3:1 against the canvas.
- **Media stays dark.** In `light`, surfaces that sit on artwork or video keep the Graphite roles: on desktop the `.on-media` class (Home hero, item backdrop and hero, episode thumbnails, player, OSD, photo viewer and slideshow, reader, now playing, tune card), on mobile `G.media` while the player or the reader is started (a count, so overlapping activities keep it). The OSD window is always Graphite. A dark band never ends on a hard edge: the Home hero fades its last 96px into the canvas, and the item page's sections below the hero sit on the light canvas, faded in over 72px, as in Apple TV and Google TV. White channel logos are drawn in ink on the light canvas; only a light coloured logo gets a plate.
- **Previews are real.** Desktop `ThemeCards` gives each card its own `data-theme` and `data-accent`, so it paints with that theme's tokens inside any other; the TV `ThemeCard` and the mobile `ThemePicker` draw from `Tokens.Palette` the same way.
- **Adding a theme**: an entry in `tokens.json` (only the roles that differ from graphite), its id in `THEMES` (`apps/desktop/src/shared/contract.ts`, checked by tokens-check), a label in the desktop `settings.appearance.theme` catalogue and in `themeLabel` (`core/ui/Themes.kt`) with FR and EN strings.

## Principles

1. **Content first.** Chrome is translucent and neutral, and artwork carries the colour. Use no decorative borders. Separate things with space, not lines; when a line is needed, use `--separator` (8 % white).
2. **One accent.** `--accent` defaults to system blue and is user-selectable (`html[data-accent]`). Use it only for primary actions, selection, progress and focus, and never for large surfaces.
3. **Materials.** Floating chrome (title bar, sidebar on Mica, OSD, sheets, menus, toasts) uses `.material` / `.material-thin` (translucent + `backdrop-filter: var(--blur)`). Content cards use `--bg-elevated`. `html[data-reduce-transparency]` turns every material opaque, so always go through the tokens.
4. **Type.** Use Geist only, with Geist Mono for timecodes and technical readouts (`.mono`, tabular numbers). The scale is `.large-title` 34, `.title-1` 28, `.title-2` 22, `.title-3` 19, `.headline` 15/600, body 14, `.callout` 13, `.footnote` 12, `.caption` 11, and `.eyebrow` (11, uppercase, tracked). Use tight negative tracking on large sizes. Never use all-caps headlines. Hero titles use `--fs-hero`, weight 700–750 and tracking -0.03em.
5. **Shape.** Radii are `--r-xs` 6, `--r-sm` 10, `--r-md` 14, `--r-lg` 20 and `--r-xl` 28. Posters use `--r-md`, buttons are pills, and sheets and dialogs use `--r-xl`.
6. **Depth.** Use `--shadow-1..3`. A focused or hovered poster lifts: scale 1.04–1.06, `--shadow-3` and a soft specular highlight, like the tvOS parallax focus.

## Motion (smooth, GPU only)

- **Colour never animates.** Hover, selection, focus, pressed states and tab switches change `color`, `background`, `border-color` and `box-shadow` instantly. Only `transform`, `opacity` and (rarely) `filter` animate, and only for things that move: page changes, sheets and menus, the shared-element morph, the focus lift and the press scale. Never transition `width`, `height`, `top`, `left`, `margin` or `padding`: switch them instantly, or scale an inner element with `scaleX()`. For a shadow that comes and goes, put it on a `::after` and fade that pseudo-element's `opacity` (`Card.svelte`, photo albums and people).
- **Three durations.** `--t-fast` 160 ms (press release, image fade-in, small fades), `--t-med` 320 ms (sheets, menus, crossfades, OSD) and `--t-slow` 560 ms (page view transition, poster-to-hero morph, sidebar FLIP, hero slide crossfade). Script animations (Svelte transitions, WAAPI) use `dur('fast' | 'med' | 'slow')` from `lib/motion.ts`. A press-in is `calc(var(--t-fast) / 2)`. List cells stagger by `--t-stagger` (30 ms).
- **Three curves.** `--ease` (Apple sheet curve) for UI moves and sheets, `--ease-out` for entrances, `--ease-in-out` only for symmetric crossfades. `--spring` is kept for the press release and the focus lift; it is damped and peaks at 1.015, so nothing visibly bounces.
- **Reduced motion.** `--tempo` (and `dur()`) scales every token; it drops to 0.001 under `prefers-reduced-motion` or the app's own reduce-motion setting (`html[data-reduce-motion]`), so animations become instant. Loops do not use `--tempo` (a 1 ms loop flickers): spinners use `--t-spin` and turn three times slower, decorative loops (`animation-play-state: var(--loop)`) pause.
- **Exceptions**, each marked `/* motion-ok: … */` in the code: the 120/280 ms page hand-off in `app.css` (the old page clears before the new one settles, so two dense pages never overlap), fades timed with the main process (player and OSD exit, `EXIT_FADE_MS`), the photo slideshow's Ken Burns (it lasts as long as the slide), the up-next countdown bar and the onboarding's ambient loops.
- `tools/checks/motion-check.mjs` (in `npm run checks`) fails on a transitioned colour, shadow or size, and on any duration that is not a token.
- Page changes go through the View Transitions API (`lib/router.svelte.ts`), and the scroller carries `view-transition-name: page`. For shared-element morphs (poster into the item hero), give the clicked element and its counterpart on the next page the same `view-transition-name` (unique per page, e.g. `poster-<id>`). Set it on click only, then remove it after the transition.
- **Idle means 0 frames.** A screen nobody touches draws nothing: no endless animation on Home or the item page. The hero holds a still image (`scale(1.08)`), crossfades in `--t-slow` and advances on a timer; its active dot is a still pill. Home shelves have no entrance stagger: inside `content-visibility: auto` shelves it kept Chromium drawing a main-thread frame on every refresh.
- List entrances (`.enter`, Library, Music, Favorites, History, item page) stagger with `animation-delay: calc(var(--i) * var(--t-stagger))`, at most 12 cells, and only on forward visits: `entering()` from `lib/motion.ts` is read once at mount, so a page reached with Back reappears as it was.
- Add `will-change: transform` only to elements that are animating or about to (hover and focus targets), never globally.
- Long grids use `content-visibility: auto` with `contain-intrinsic-size`, or windowing, so scrolling stays at the display refresh rate (144–360 Hz).
- Scrollbars are the platform's thin ones (`scrollbar-width: thin`, `scrollbar-color` in `app.css`), shown while the pointer is over the scroller. Never style `::-webkit-scrollbar`: Chromium paints it on the main thread on every scrolled frame.
- Large blurs are pre-rendered: the item page's ambient art is drawn once, blurred, into a 48 px canvas (`ambient` in `lib/motion.ts`) that CSS stretches, instead of a full-window `filter: blur()`.
- Images fade in on `load` (opacity 0 to 1, `--t-med`) over a `--fill-1` placeholder (or a BlurHash when the server sends one), with `decoding="async"` and `loading="lazy"`.

## Interaction

- Hover: subtle `--fill-2` or `--fill-3` backgrounds, switched instantly. Press: `scale(0.96)` with a spring release.
- Focus (keyboard, gamepad or remote): `--focus-ring` plus a lift on cards. Spatial navigation lives in `lib/spatial.ts`, so every interactive element must be reachable by arrow keys.
- Text: French UI, sentence case, short. Use no hex dumps or terminal jargon. Technical details belong in a quiet `.caption` or a disclosure.

## Icons

- Lucide (`@lucide/svelte`) through `components/Icon.svelte`, stroke 1.5, monochrome: `--label-2` at rest, `--label` on hover and when active. Never colour an icon with the accent or a system colour in navigation or lists.
- Icons are static. No wiggle, pop, bounce or ring animations: they look cheap.
- No coloured rounded squares behind icons (macOS-settings rainbow): it reads as generic and template-made.

## Don'ts

- Don't use the old pre-Graphite language: no clutch red, no hexdump headers, no Big Shoulders, no uppercase display type, no "chill" mode.
- Don't add new colours outside the tokens or animate layout properties.
- Don't add new runtime dependencies without a real reason.
- Don't use filled accent pills for selected navigation rows. Show selection with a subtle `--fill-2` background instead.
