// Remote keys, normalized across Tizen, webOS and a desktop browser (arrows, Enter, Backspace/Escape for Back).
export type Key =
  | 'up' | 'down' | 'left' | 'right' | 'ok' | 'back'
  | 'play' | 'pause' | 'playPause' | 'stop' | 'ff' | 'rw' | 'next' | 'prev'
  | 'red' | 'green' | 'yellow' | 'blue' | 'info' | 'channelUp' | 'channelDown';

// keyCode → key. Tizen and webOS share the DOM codes for arrows and Enter; Back and the media keys differ.
const CODES: Record<number, Key> = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok',
  8: 'back', 27: 'back', 10009: 'back', 461: 'back',
  415: 'play', 19: 'pause', 10252: 'playPause', 179: 'playPause', 413: 'stop',
  417: 'ff', 412: 'rw', 10233: 'next', 10232: 'prev', 176: 'next', 177: 'prev',
  403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info',
  427: 'channelUp', 428: 'channelDown', 33: 'channelUp', 34: 'channelDown',
};

export function keyOf(e: KeyboardEvent): Key | null {
  return CODES[e.keyCode] ?? null;
}
