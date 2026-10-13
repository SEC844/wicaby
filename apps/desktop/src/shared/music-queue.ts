// Pure play-queue operations (music-spec MU-01): move, remove, jump, insert, clear the upcoming entries,
// shuffle with a seeded RNG and its undo, and the repeat-aware next index. main/playback/play-queue.ts
// applies them; the Kotlin twin is core/music/MusicQueue.kt. Both run tools/checks/fixtures/music/queue-vectors.json.

export type Repeat = 'off' | 'all' | 'one';

export interface QueueState {
  ids: string[];
  index: number;
  repeat: Repeat;
  // The order before shuffle, for its undo; null while not shuffled.
  unshuffled: string[] | null;
}

export type QueueOp =
  | { op: 'move'; from: number; to: number }
  | { op: 'remove'; index: number }
  | { op: 'jump'; index: number }
  | { op: 'insertNext'; ids: string[] }
  | { op: 'append'; ids: string[] }
  | { op: 'clearUpcoming' }
  | { op: 'shuffle'; seed: number }
  | { op: 'unshuffle' }
  | { op: 'repeat'; mode: Repeat };

// mulberry32: a small 32-bit generator with the same output in Kotlin (Int arithmetic wraps like Math.imul).
export function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inRange = (s: QueueState, i: number) => Number.isInteger(i) && i >= 0 && i < s.ids.length;

// A new state; an op that does not apply (index out of range) returns the state unchanged.
export function applyQueueOp(s: QueueState, op: QueueOp): QueueState {
  const ids = s.ids.slice();
  switch (op.op) {
    case 'move': {
      if (!inRange(s, op.from) || !inRange(s, op.to) || op.from === op.to) return s;
      const [id] = ids.splice(op.from, 1);
      ids.splice(op.to, 0, id);
      // The playing entry keeps playing wherever it lands.
      let index = s.index;
      if (op.from === s.index) index = op.to;
      else if (op.from < s.index && op.to >= s.index) index--;
      else if (op.from > s.index && op.to <= s.index) index++;
      return { ...s, ids, index };
    }
    case 'remove': {
      if (!inRange(s, op.index)) return s;
      ids.splice(op.index, 1);
      // Removing the playing entry makes the next one current (the last one when it was the end).
      const index = op.index < s.index ? s.index - 1 : Math.min(s.index, Math.max(0, ids.length - 1));
      return { ...s, ids, index };
    }
    case 'jump':
      return inRange(s, op.index) ? { ...s, index: op.index } : s;
    case 'insertNext':
      ids.splice(s.ids.length ? s.index + 1 : 0, 0, ...op.ids);
      return { ...s, ids };
    case 'append':
      return { ...s, ids: [...ids, ...op.ids] };
    case 'clearUpcoming':
      return { ...s, ids: ids.slice(0, s.index + 1) };
    case 'repeat':
      return { ...s, repeat: op.mode };
    case 'shuffle': {
      if (s.unshuffled || !ids.length) return s;
      // The playing entry goes first, the rest (before and after it) in a seeded Fisher-Yates order.
      const [current] = ids.splice(s.index, 1);
      const rnd = seededRandom(op.seed);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      return { ...s, ids: [current, ...ids], index: 0, unshuffled: s.ids.slice() };
    }
    case 'unshuffle': {
      if (!s.unshuffled) return s;
      // The old order of what is still queued, then what was added since, in its current order.
      const left = new Map<string, number>();
      for (const id of s.ids) left.set(id, (left.get(id) ?? 0) + 1);
      const restored: string[] = [];
      for (const id of [...s.unshuffled, ...s.ids]) {
        const n = left.get(id) ?? 0;
        if (n > 0) {
          restored.push(id);
          left.set(id, n - 1);
        }
      }
      // shortcut: a track queued twice resumes at its first copy; entry keys would be needed to tell copies apart.
      const index = Math.max(0, restored.indexOf(s.ids[s.index]));
      return { ...s, ids: restored, index, unshuffled: null };
    }
  }
}

// The entry that plays after the current one, -1 for none. Repeat one replays it, unless the user asked for
// the next one (manual); repeat all wraps to the start.
export function nextIndex(s: QueueState, manual = false): number {
  if (!s.ids.length) return -1;
  if (s.repeat === 'one' && !manual) return s.index;
  if (s.index + 1 < s.ids.length) return s.index + 1;
  return s.repeat === 'off' ? -1 : 0;
}
