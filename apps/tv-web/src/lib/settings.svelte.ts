// TV preferences (Android TvSettings and the :core Prefs the TV reads): same keys and defaults, stored on the TV,
// reactive so the screens follow a change made in Settings.
import { arrange, decode, encode, type HomePref, RESUME, NEXT_UP, latestViewId } from './home-rows';
import { load, save } from './storage';

export class Setting<T> {
  #value = $state<T>() as T;
  constructor(private readonly key: string, fallback: T) {
    this.#value = load<T>(`tv.${key}`, fallback);
  }
  get value(): T {
    return this.#value;
  }
  set value(v: T) {
    this.#value = v;
    save(`tv.${this.key}`, v);
  }
}

export const SKIP_ASK = 0;
export const SKIP_AUTO = 1;
export const SKIP_OFF = 2;
export const RESUME_AUTO = 0;
export const RESUME_ASK = 1;
export const RESUME_START = 2;
export const PASS_AUTO = 0;
export const PASS_ON = 1;
export const PASS_OFF = 2;
export const PASS_CODECS = ['ac3', 'eac3', 'dts', 'truehd'] as const;
// ScopedPrefs.Scope ordinals: off, global, library, title.
export const SCOPE_GLOBAL = 1;
export const SCOPE_TITLE = 3;

export const settings = {
  // Playback
  mbpsEthernet: new Setting('mbps_ethernet', 0), // 0 = auto
  mbpsWifi: new Setting('mbps_wifi', 0),
  autoplayNext: new Setting('autoplay_next', true),
  countdown: new Setting('countdown_s', 15),
  skipIntro: new Setting('skip_intro', SKIP_ASK),
  skipRecap: new Setting('skip_recap', SKIP_ASK),
  skipPreview: new Setting('skip_preview', SKIP_ASK),
  skipCommercial: new Setting('skip_commercial', SKIP_ASK),
  resume: new Setting('resume', RESUME_AUTO),
  passthrough: Object.fromEntries(PASS_CODECS.map((c) => [c, new Setting(`pass_${c}`, PASS_AUTO)])) as Record<(typeof PASS_CODECS)[number], Setting<number>>,
  subtitleSize: new Setting('sub_size', 1),
  subtitleStyle: new Setting('sub_style', 0), // 0 outline, 1 shadow, 2 box
  subtitleFont: new Setting('sub_font', 0),
  subtitleColor: new Setting('sub_color', 0),
  subtitlePosition: new Setting('sub_pos', 0),
  subtitleOverrideAss: new Setting('sub_ass_override', false),
  rememberSpeed: new Setting('remember_speed', SCOPE_GLOBAL),
  rememberAspect: new Setting('remember_aspect', SCOPE_TITLE),
  // "Play on" target for the official Emby/Jellyfin apps (X-06).
  remoteControl: new Setting('remote_control', true),
  // Accessibility (core Core.preferSdh, Core.audioDescription): prefer, avoid or any.
  preferSdh: new Setting('prefer_sdh', false),
  audioDescription: new Setting<'prefer' | 'avoid' | 'any'>('audio_description', 'avoid'),
  // Anime openings and endings from aniskip.com when the server has no markers (core AniSkip.enabled).
  aniskip: new Setting('aniskip', false),
  // Interface
  language: new Setting<'auto' | 'fr' | 'en'>('language', 'auto'),
  clock: new Setting('clock', true),
  // Theme id, as the desktop's ui.theme (packages/tokens/tokens.json). Builds before the theme list stored a boolean
  // "oled": it becomes the theme id until a theme is picked (TvSettings.kt).
  theme: new Setting('theme', load<boolean>('tv.oled', false) ? 'oled' : 'graphite'),
  // The Home hint (OLED or Cinéma for a living room), shown once while the TV is on the default theme.
  themeHintShown: new Setting('theme_hint_shown', false),
  accent: new Setting('accent', 0), // index into the theme's accents (lib/theme.ts)
  // The in-app screensaver: after that many idle minutes on Home (0 = never), showing film backdrops, photos or
  // "On this day" from an album or library ("" = every photo). Photos spec PH-07.
  screensaverMin: new Setting('screensaver_min', 0),
  screensaverSource: new Setting<'backdrops' | 'photos' | 'memories'>('screensaver_source', 'backdrops'),
  screensaverAlbum: new Setting('screensaver_album', ''),
  rowHero: new Setting('row_hero', true),
  // #8: the hero carousel without watched titles (all of them when everything is watched).
  heroHideWatched: new Setting('hero_hide_watched', false),
  rowResume: new Setting('row_resume', true),
  rowNextUp: new Setting('row_nextup', true),
  // X-01: "Continuer" and "À suivre" as one "Continuer à regarder" row.
  mergeContinue: new Setting('merge_continue', true),
  rowLatest: new Setting('row_latest', true),
  // Episodes among the search results; off, a series' episodes stay on its page.
  searchEpisodes: new Setting('search_episodes', true),
};

// TP-07: home rows order, hidden and thumbnail rows per `serverId/userId`. Until the user changes them, the older
// Continue / Up Next / Latest toggles say what is hidden.
const homeVersion = $state({ n: 0 });

export function homeRows(user: string, defaults: string[]): HomePref {
  void homeVersion.n;
  return (
    decode(load<string | null>(`tv.home_rows:${user}`, null)) ?? {
      order: [],
      hidden: defaults.filter((id) =>
        id === RESUME ? !settings.rowResume.value : id === NEXT_UP ? !settings.rowNextUp.value : latestViewId(id) !== null && !settings.rowLatest.value,
      ),
      thumb: [],
    }
  );
}

export function setHomeRows(user: string, pref: HomePref): void {
  save(`tv.home_rows:${user}`, encode(pref));
  homeVersion.n++;
}

// #6: the tab bar's order and hidden tabs per `serverId/userId` (Android TvSettings.tabBar).
const tabVersion = $state({ n: 0 });

export function tabBarPref(user: string): HomePref {
  void tabVersion.n;
  return decode(load<string | null>(`tv.tab_bar:${user}`, null)) ?? { order: [], hidden: [], thumb: [] };
}

export function setTabBarPref(user: string, pref: HomePref): void {
  save(`tv.tab_bar:${user}`, encode(pref));
  tabVersion.n++;
}

export { arrange };
