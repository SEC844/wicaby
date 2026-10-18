// TV preferences (Android TvSettings and the :core Prefs the TV reads): same keys and defaults, stored on the TV,
// reactive so the screens follow a change made in Settings.
import { arrange, decode, encode, type HomePref, RESUME, NEXT_UP, latestViewId } from './home-rows';
import { load, save } from './storage';

class Setting<T> {
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

export const settings = {
  // Interface
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
