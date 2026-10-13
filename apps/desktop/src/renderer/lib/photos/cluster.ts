// Photos map (spec PH-09): markers grouped within 60 px per zoom level, in Web Mercator pixels (256 px
// tiles). Pure and dependency-free; the vectors in tools/checks/fixtures/photos/photo-fixtures.json pin it
// (tools/checks/photos-check.mjs). TS only: there is no map on Android (decision O2).

export interface GeoPoint {
  lat: number;
  lon: number;
  // Wall-clock "YYYY-MM-DDTHH:MM:SS": the newest point gives the cluster's thumbnail.
  takenAt: string;
}

export interface Cluster {
  // The members' mean position.
  lat: number;
  lon: number;
  count: number;
  // Position in the points given of the newest member.
  newest: number;
  // Positions in the points given, in their order.
  indexes: number[];
}

const MAX_LAT = 85.05112878;

// World pixel of a position at zoom z.
export function project(lat: number, lon: number, z: number): [number, number] {
  const size = 256 * 2 ** z;
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * size;
  const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * size;
  return [x, y];
}

// Greedy, over a grid index of 60 px cells: each point not yet taken (in the order given) takes every free point within
// 60 px of it, found in its own and the 8 neighbouring cells. Unlike plain cell binning, a group of photos never splits
// on a cell edge.
export function cluster(points: GeoPoint[], z: number, cell = 60): Cluster[] {
  const px = points.map((p) => (Number.isFinite(p.lat) && Number.isFinite(p.lon) ? project(p.lat, p.lon, z) : null));
  const key = (cx: number, cy: number) => `${cx}:${cy}`;
  const grid = new Map<string, number[]>();
  px.forEach((q, i) => {
    if (!q) return;
    const k = key(Math.floor(q[0] / cell), Math.floor(q[1] / cell));
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  const taken = new Uint8Array(points.length);
  const out: Cluster[] = [];
  px.forEach((q, i) => {
    if (!q || taken[i]) return;
    const cx = Math.floor(q[0] / cell);
    const cy = Math.floor(q[1] / cell);
    const indexes: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (taken[j] || (px[j]![0] - q[0]) ** 2 + (px[j]![1] - q[1]) ** 2 > cell * cell) continue;
          taken[j] = 1;
          indexes.push(j);
        }
    indexes.sort((a, b) => a - b);
    const c: Cluster = { lat: 0, lon: 0, count: indexes.length, newest: indexes[0], indexes };
    for (const j of indexes) {
      c.lat += points[j].lat / c.count;
      c.lon += points[j].lon / c.count;
      if (points[j].takenAt > points[c.newest].takenAt) c.newest = j;
    }
    out.push(c);
  });
  return out;
}
