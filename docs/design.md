# Wicaby design system: "Graphite"

Wicaby looks and moves like an Apple app (tvOS / macOS Sonoma / Apple TV app) built on Windows 11. It is sleek, quiet and content-first. The posters and artwork are the colour; the chrome is neutral graphite plus one accent.

Tokens live in `apps/desktop/src/renderer/app.css`. The Android apps (`apps/android/`) mirror the same tokens in Compose.

## Principles

1. **Content first.** Chrome is translucent and neutral, and artwork carries the colour. Use no decorative borders. Separate things with space, not lines; when a line is needed, use `--separator` (8 % white).
2. **One accent.** `--accent` defaults to system blue and is user-selectable (`html[data-accent]`). Use it only for primary actions, selection, progress and focus, and never for large surfaces.
3. **Materials.** Floating chrome (title bar, sidebar on Mica, OSD, sheets, menus, toasts) uses `.material` / `.material-thin` (translucent + `backdrop-filter: var(--blur)`). Content cards use `--bg-elevated`. `html[data-reduce-transparency]` turns every material opaque, so always go through the tokens.
4. **Type.** Use Geist only, with Geist Mono for timecodes and technical readouts (`.mono`, tabular numbers). The scale is `.large-title` 34, `.title-1` 28, `.title-2` 22, `.title-3` 19, `.headline` 15/600, body 14, `.callout` 13, `.footnote` 12, `.caption` 11, and `.eyebrow` (11, uppercase, tracked). Use tight negative tracking on large sizes. Never use all-caps headlines. Hero titles use `--fs-hero`, weight 700–750 and tracking -0.03em.
5. **Shape.** Radii are `--r-xs` 6, `--r-sm` 10, `--r-md` 14, `--r-lg` 20 and `--r-xl` 28. Posters use `--r-md`, buttons are pills, and sheets and dialogs use `--r-xl`.
6. **Depth.** Use `--shadow-1..3`. A focused or hovered poster lifts: scale 1.04–1.06, `--shadow-3` and a soft specular highlight, like the tvOS parallax focus.

## Motion (smooth, GPU only)

- Animate only `transform`, `opacity` and `filter`. Never transition `width`, `height`, `top`, `left`, `margin`, `padding` or `box-shadow` on many elements. For a shadow change, fade the `opacity` of a pseudo-element that holds the shadow.
- Use `--ease` (Apple sheet curve) for UI, `--ease-out` for entrances, and `--spring` (CSS `linear()` spring) for presses, focus lifts and toggles. Durations are `--t-fast` 160 ms, `--t-med` 320 ms and `--t-slow` 560 ms. Every duration is multiplied by `--tempo`, which drops to about 0 under reduced motion, so always use the tokens.
- Page changes go through the View Transitions API (`lib/router.svelte.ts`), and the scroller carries `view-transition-name: page`. For shared-element morphs (poster into the item hero), give the clicked element and its counterpart on the next page the same `view-transition-name` (unique per page, e.g. `poster-<id>`). Set it on click only, then remove it after the transition.
- Lists stagger in with `animation-delay: calc(var(--i) * 30ms * var(--tempo))` and are capped at about 12 items.
- Add `will-change: transform` only to elements that are animating or about to (hover and focus targets), never globally.
- Long grids use `content-visibility: auto` with `contain-intrinsic-size`, or windowing, so scrolling stays at the display refresh rate (144–360 Hz).
- Images fade in on `load` (opacity 0 to 1, `--t-med`) over a `--fill-1` placeholder (or a BlurHash when the server sends one), with `decoding="async"` and `loading="lazy"`.

## Interaction

- Hover: subtle `--fill-2` or `--fill-3` backgrounds. Press: `scale(0.96)` with a spring release.
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
