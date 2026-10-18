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

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_TEST_STREAM?: string;
}

