// The A–Z jump rail of a library sorted by name (Android core LetterIndex.kt). Where each letter starts comes from
// the server itself: for each letter, how many items sort before it (NameLessThan, Limit 0: a count, no items), so a
// jump lands on the right offset of a paginated library in its own SortName order, without loading it. Both servers
// keep SortName lower case (leading articles already dropped by their own settings), hence the lower-case bounds.
import type { Query } from './api';

export const LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Letters NFD does not split: the ligatures and stroked letters of Latin alphabets.
const LIGATURES: Record<string, string> = { Œ: 'O', Æ: 'A', Ø: 'O', Ł: 'L', Đ: 'D', ẞ: 'S', ß: 'S' };

// The rail letter of a name: A–Z with accents folded (É → E), '#' for digits, symbols and other scripts.
export function letterOf(name: string | undefined): string {
  const c = name?.replace(/^\s+/, '')[0];
  if (!c) return '#';
  const lig = LIGATURES[c.toUpperCase()] ?? LIGATURES[c];
  if (lig) return lig;
  const base = c.normalize('NFD')[0].toUpperCase();
  return base >= 'A' && base <= 'Z' ? base : '#';
}

export function indexOf(letter: string): number {
  return Math.max(0, LETTERS.indexOf(letter));
}

// The 27 bounds asked for: before 'a' … before 'z', then before '{' (just past 'z': the end of Z).
export const BOUNDS: string[] = [...'abcdefghijklmnopqrstuvwxyz'.split(''), '{'];

// Each rail letter's first offset, -1 when it has no item. before[i] = items sorting before BOUNDS[i].
// '#' holds what sorts before 'a'; what sorts past 'z' (an accent the server does not fold) has no letter.
export function offsets(before: number[]): number[] {
  if (before.length !== BOUNDS.length) throw new Error('one count per bound');
  const out = new Array<number>(LETTERS.length).fill(-1);
  if (before[0] > 0) out[0] = 0;
  for (let i = 0; i < 26; i++) if (before[i + 1] > before[i]) out[i + 1] = before[i];
  return out;
}

// The letter an offset falls in (the last letter starting at or before it), for entering the rail; 0 ('#') if none.
export function letterAt(offs: number[], index: number): number {
  for (let i = offs.length - 1; i >= 0; i--) if (offs[i] >= 0 && offs[i] <= index) return i;
  return 0;
}

// The letter the rail opens on for the item at [index] named [name]: its own (accents folded) when the server sorts
// it there, else the letter its offset falls in (a leading article the server drops: "The Matrix" sits in M).
export function entry(offs: number[], index: number, name: string | undefined): number {
  const own = indexOf(letterOf(name));
  const start = offs[own] ?? -1;
  const end = offs.slice(own + 1).find((o) => o >= 0) ?? Number.MAX_SAFE_INTEGER;
  return start >= 0 && start <= index && index < end ? own : letterAt(offs, index);
}

// The nearest letter with items from [i] going [step] (+1 down, -1 up); [i] itself when none.
export function next(offs: number[], i: number, step: 1 | -1): number {
  for (let j = i + step; j >= 0 && j < offs.length; j += step) if (offs[j] >= 0) return j;
  return i;
}

// The letter Left from the grid lands on (tv AlphaRail.kt railLetter): [i] when it has titles, else the nearest.
export function railLetter(offs: number[], i: number): number {
  if ((offs[i] ?? -1) >= 0) return i;
  const down = next(offs, i, 1);
  return offs[down] >= 0 ? down : next(offs, i, -1);
}

// The counts, in parallel, from any count query (the grid's own filters).
export async function load(count: (bound: string) => Promise<number>): Promise<number[]> {
  return offsets(await Promise.all(BOUNDS.map(count)));
}

export function countOnly(bound: string): Query {
  return { NameLessThan: bound, Limit: 0, EnableImages: false, EnableUserData: false };
}
