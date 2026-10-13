// Photos (spec PH-01, F7): "on this day". Kotlin twin: core photos/Memories.kt (same fixtures).
export interface Memory {
  yearsAgo: number;
  // Positions in the assets given, in their order.
  indexes: number[];
}

const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// "YYYY-MM-DD" moved by d days (an invalid day such as a Feb 29 rolls over, like Date.UTC).
const shiftDay = (ymd: string, d: number) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + d)).toISOString().slice(0, 10);

// Assets taken on today's month and day ("YYYY-MM-DD", wall-clock) in earlier years, the nearest year first.
// Feb 29 shows on Feb 28 in a year without one.
export function memories(assets: { takenAt: string }[], today: string): Memory[] {
  const year = Number(today.slice(0, 4));
  const md = today.slice(5, 10);
  const days = md === "02-28" && !leap(year) ? ["02-28", "02-29"] : [md];
  const byYear = new Map<number, number[]>();
  assets.forEach((a, i) => {
    const y = Number(a.takenAt.slice(0, 4));
    if (y >= year || !days.includes(a.takenAt.slice(5, 10))) return;
    const list = byYear.get(y) ?? [];
    list.push(i);
    byYear.set(y, list);
  });
  return [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([y, indexes]) => ({ yearsAgo: year - y, indexes }));
}

// The query side (spec §3.1, PH-08 AC3), twin of core photos/Memories.kt memoryPhotos: the years once, then one
// premiere-date range per earlier year (the 10 nearest, three in flight), kept by memories() above so the Feb 29 rule
// holds. years: the years present (/Years); range: the photos between two wall-clock bounds. Returns the memories and
// the items they index.
export async function memoryQuery<T>(
  years: () => Promise<number[]>,
  range: (min: string, max: string) => Promise<T[]>,
  takenAt: (item: T) => string,
  today: string,
): Promise<{ items: T[]; memories: Memory[] }> {
  const year = Number(today.slice(0, 4));
  const md = today.slice(5, 10);
  const wanted = [...new Set(await years())].filter((y) => y < year).sort((a, b) => b - a).slice(0, 10);
  const found: T[][] = [];
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const k = next++;
      const y = wanted[k];
      const last = md === "02-28" && !leap(year) && leap(y) ? "02-29" : md;
      // ±1 day (spec §3.1 step 2): the server may read the zoneless bounds in its own zone; memories() keeps the day.
      found[k] = await range(`${shiftDay(`${y}-${md}`, -1)}T00:00:00`, `${shiftDay(`${y}-${last}`, 1)}T23:59:59`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const items = found.flat();
  return { items, memories: memories(items.map((x) => ({ takenAt: takenAt(x) })), today) };
}

// Today as "YYYY-MM-DD" in local time (the wall-clock day memories compare with).
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
