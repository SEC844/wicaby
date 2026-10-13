// Natural order of file and folder names (file-sources-spec §4.1), the same on desktop and Android:
// digit runs compare by value then by length (longer first: '01' before '1'), other runs case- and
// accent-folded by code point, digits before letters at the same place, then the raw names.
// Not Intl.Collator: its order depends on the ICU build. Vectors: tools/checks/fixtures/files/natsort.json.

const RUN = /\d+|\D+/g;

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function digits(a: string, b: string): number {
  const x = a.replace(/^0+/, '');
  const y = b.replace(/^0+/, '');
  // Equal values: the longer spelling first.
  return x.length - y.length || cmp(x, y) || b.length - a.length;
}

export function natCompare(a: string, b: string): number {
  const ra = a.normalize('NFC').match(RUN) ?? [];
  const rb = b.normalize('NFC').match(RUN) ?? [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const da = /^\d/.test(ra[i]);
    const db = /^\d/.test(rb[i]);
    if (da !== db) return da ? -1 : 1;
    const c = da ? digits(ra[i], rb[i]) : cmp(fold(ra[i]), fold(rb[i]));
    if (c) return c;
  }
  return ra.length - rb.length || cmp(a, b);
}
