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
  // Interface
  language: new Setting<'auto' | 'fr' | 'en'>('language', 'auto'),
  clock: new Setting('clock', true),
  oled: new Setting('oled', false),
  accent: new Setting('accent', 0), // index into ACCENTS
  rowHero: new Setting('row_hero', true),
  rowResume: new Setting('row_resume', true),
  rowNextUp: new Setting('row_nextup', true),
  // X-01: "Continuer" and "À suivre" as one "Continuer à regarder" row.
  mergeContinue: new Setting('merge_continue', true),
  rowLatest: new Setting('row_latest', true),
};

// Theme.kt Accents, same order.
export const ACCENTS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#30d158', '#d1d1d6'];
export const onAccent = (i: number): string => (i === 5 || i === 6 || i === 7 ? '#000' : '#fff');

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

export { arrange };
