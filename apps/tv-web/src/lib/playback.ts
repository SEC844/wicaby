// The one door to playback (Android tv play(), shuffle(), playTrailer(), ReaderActivity.start()). Every screen calls
// these; milestone M2 (the player: AVPlay / <video>, PlaybackInfo with the TV's device profile, progress reporting)
// fills them in. Until then they are deliberately inert.
import type { BaseItem } from '$shared/models';

export interface PlayOptions {
  // From the start, ignoring the resume point ("Depuis le début").
  fromStart?: boolean;
}

export function play(item: BaseItem, opts: PlayOptions = {}): void {
  void item;
  void opts;
}

// Every episode of a series or season in random order, as a play queue (desktop's Item page, TP-04).
export function shuffle(item: BaseItem): void {
  void item;
}

// A trailer or bonus: from the start, nothing reported, no Watch Next entry.
export function playTrailer(item: BaseItem): void {
  void item;
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
