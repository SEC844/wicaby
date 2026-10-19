/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module 'virtual:strings' {
  interface Catalog {
    strings: Record<string, string>;
    plurals: Record<string, Partial<Record<'zero' | 'one' | 'two' | 'few' | 'many' | 'other', string>>>;
  }
  const catalogs: Record<'fr' | 'en', Catalog>;
  export default catalogs;
}

declare module 'virtual:icons' {
  // Names from object Ic in the Android TV ui/Theme.kt (Play, Pause, Check, Heart, Search, Gear…).
  const icons: Record<string, string>;
  export default icons;
}

declare module 'virtual:tokens' {
  // The TV themes of packages/tokens/tokens.json, in its order (graphite first, the default).
  export interface TvTheme {
    id: string;
    // CSS custom properties (--bg, --label, --fill-2…) as rgb()/rgba().
    vars: Record<string, string>;
    // Theme.kt Accents in this theme's tones, with the text colour on each.
    accents: { color: string; fg: string }[];
  }
  const themes: TvTheme[];
  export default themes;
}

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_TEST_STREAM?: string;
}

