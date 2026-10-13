// Cast (cast-spec CA-04): the active cast as main mirrors it, and the picker request. Each window (main, OSD)
// has its own copy; main owns the cast itself and never hands the renderer a token.
import type { CastStartOptions, CastState, PlayRequest } from '../../shared/contract';
import { w } from './bridge';
import { errorMessage, toast } from './stores.svelte';

interface PickerRequest {
  itemId: string;
  serverId?: string;
  // What to play (item page, menu), resolved on pick; absent = hand off the player's item. null = cancelled.
  options?: () => Promise<CastStartOptions | null>;
}

export const cast = $state<{ state: CastState | null; picker: PickerRequest | null }>({ state: null, picker: null });

let ready = false;
export function initCast(): void {
  if (ready) return;
  ready = true;
  w.cast.onState((s) => {
    cast.state = s;
  });
  void w.cast.getState().then((s) => (cast.state = s));
}

export function openCastPicker(request: PickerRequest): void {
  cast.picker = request;
}

export function closeCastPicker(): void {
  cast.picker = null;
}

export async function castTo(key: string): Promise<void> {
  const req = cast.picker;
  cast.picker = null;
  if (!req) return;
  try {
    const options = req.options ? await req.options() : undefined;
    if (options === null) return;
    await w.cast.start(key, options);
  } catch (err) {
    toast('error', errorMessage(err));
  }
}

// The request the Play button would send, as cast options (same queue, resume point and tracks).
export function castOptions(r: PlayRequest | null): CastStartOptions | null {
  return r && { itemIds: r.itemIds, startIndex: r.startIndex, positionTicks: r.startPositionTicks, msid: r.mediaSourceId, audio: r.audioStreamIndex, sub: r.subtitleStreamIndex };
}
