import { k } from '../../lib/i18n.svelte';

// The languages the audio and subtitle preferences offer (Settings.kt LANGS): ISO 639-2 codes, "" for automatic.
export const LANGS: [string, string][] = [
  ['', k('lang_auto')], ['fre', k('lang_fre')], ['eng', k('lang_eng')], ['jpn', k('lang_jpn')], ['ger', k('lang_ger')], ['spa', k('lang_spa')], ['ita', k('lang_ita')], ['kor', k('lang_kor')],
];
