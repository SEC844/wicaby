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

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_TEST_STREAM?: string;
}
