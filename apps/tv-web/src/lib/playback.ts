// The one door to playback (Android tv play(), playQueue(), shuffle(), playTrailer()): every screen calls these, and
// they open the player screen (screens/Player.svelte) with what to play.
import type { BaseItem } from '$shared/models';
import { clock } from './format';
import { t } from './i18n.svelte';
import { nav } from './nav.svelte';
import { showAlert } from './overlay.svelte';
import { resumeFrom } from './segments';
import { api } from './session.svelte';
import { RESUME_ASK, RESUME_START, settings } from './settings.svelte';
import { showToast } from './toast.svelte';

export interface PlayOptions {
  // From the start, ignoring the resume point ("Depuis le début").
  fromStart?: boolean;
}

const resumeMs = (item: BaseItem) => resumeFrom((item.UserData?.PlaybackPositionTicks ?? 0) / 10_000, (item.RunTimeTicks ?? 0) / 10_000);

function open(item: BaseItem, fromStart: boolean): void {
  nav.push({ name: 'player', id: item.Id, serverId: item.ServerId, fromStart });
}

// Settings > Playback > Resume: at once, ask, or always from the start.
export function play(item: BaseItem, opts: PlayOptions = {}): void {
  const at = resumeMs(item);
  if (opts.fromStart || at <= 0) return open(item, !!opts.fromStart);
  if (settings.resume.value === RESUME_START) return open(item, true);
  if (settings.resume.value !== RESUME_ASK) return open(item, false);
  showAlert({
    title: t('resume_title'),
    message: item.Type === 'Episode' && item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name,
    actions: [
      { label: t('resume_at', clock(at)), run: () => open(item, false) },
      { label: t('from_start'), run: () => open(item, true) },
    ],
    focusIndex: 0,
  });
}

// TP-04: every episode or title under [item] in random order, as a queue, each from its start.
export async function shuffle(item: BaseItem): Promise<void> {
  const client = api();
  if (!client) return;
  let ids: string[];
  try {
    ids = (
      await client.items({ ParentId: item.Id, Recursive: true, IncludeItemTypes: 'Movie,Episode,Video,MusicVideo', SortBy: 'Random', Limit: 500, Fields: 'Id' })
    ).Items.map((i) => i.Id);
  } catch {
    return showToast(t('load_error'));
  }
  if (!ids.length) return showToast(t('nothing_to_play'));
  // SortBy=Random samples server-side; the local shuffle covers a cached answer.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  nav.push({ name: 'player', id: ids[0], fromStart: true, queue: ids });
}

// A trailer or bonus: from the start, nothing reported, no next episode.
export function playTrailer(item: BaseItem): void {
  nav.push({ name: 'player', id: item.Id, serverId: item.ServerId, fromStart: true, trailer: true });
}

// A book or comic: the reader (M3), at the saved page unless fromStart.
export function read(item: BaseItem, opts: PlayOptions = {}): void {
  void item;
  void opts;
}

// A remote trailer (core Trailers.remoteUrl): the TV's YouTube app, else its link as a QR code (Android TrailerQr).
export function openRemoteTrailer(url: string): void {
  void url;
}
