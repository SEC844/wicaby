// Photos (spec PH-01): the one asset shape the photo UI reads, with the date and orientation rules. Pure and
// dependency-free: core photos/PhotoAsset.kt is its Kotlin twin, and tools/checks/fixtures/photos/photo-fixtures.json
// pins both (tools/checks/photos-check.mjs here, PhotoFixturesTest on Android).
import type { BaseItem } from "../../../shared/models";

export interface PhotoAsset {
  id: string;
  serverId: string;
  kind: "photo" | "video";
  // Wall-clock "YYYY-MM-DDTHH:MM:SS", no zone (takenAt below).
  takenAt: string;
  // Width / height as shown, after the orientation.
  aspect: number;
  // The client-side turn, set once the thumbnail is decoded (rotation below).
  rotate: 0 | 90 | 180 | 270;
  durationMs?: number;
  favorite: boolean;
  thumbTag?: string;
  blurHash?: string;
  // Only when the map is on (spec §6.1): never logged, never persisted.
  lat?: number;
  lon?: number;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
const ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const p2 = (n: number, w = 2) => String(n).padStart(w, "0");

// The timeline key. PremiereDate holds the EXIF date as written: its calendar fields are taken as they are,
// whatever zone suffix comes with them (Jellyfin sends none, Emby a Z). Without one (or with a placeholder year),
// DateCreated, which both servers send in UTC, in local time. offsetMin: minutes east of UTC; the device's zone
// at that instant when left out.
export function takenAt(premiereDate?: string | null, dateCreated?: string | null, offsetMin?: number): string | null {
  const m = premiereDate ? WALL.exec(premiereDate) : null;
  if (m && Number(m[1]) > 1800) return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  if (!dateCreated || !WALL.test(dateCreated)) return null;
  // A zoneless DateCreated is UTC too (Date.parse would read it as local).
  const ms = Date.parse(ZONE.test(dateCreated) || dateCreated.length <= 10 ? dateCreated : `${dateCreated}Z`);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + (offsetMin ?? -new Date(ms).getTimezoneOffset()) * 60_000);
  return `${p2(d.getUTCFullYear(), 4)}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// The clockwise quarter turn an EXIF orientation asks for. shortcut: the mirrored LeftTop and RightBottom are only
// turned, not flipped (cameras do not write them); flip them too if a server ever sends one.
export function quarterTurn(orientation?: string | null): 0 | 90 | 270 {
  if (orientation === "RightTop" || orientation === "LeftTop") return 90;
  return orientation === "LeftBottom" || orientation === "RightBottom" ? 270 : 0;
}

// Width / height as shown: swapped for a quarter turn. Else the server's PrimaryImageAspectRatio, else 3:2.
export function displayAspect(width?: number | null, height?: number | null, orientation?: string | null, primaryAspect?: number | null): number {
  if (width && height && width > 0 && height > 0) return quarterTurn(orientation) ? height / width : width / height;
  return primaryAspect && primaryAspect > 0 ? primaryAspect : 1.5;
}

// Spec §3.1 orientation rule, once the thumbnail is decoded: a quarter-turn asset whose pixels still have the
// unrotated shape is turned by the client (CSS transform, graphicsLayer.rotationZ); pixels the server or the
// decoder already turned (shape swapped) are left alone.
export function rotation(orientation: string | null | undefined, width: number, height: number, decodedW: number, decodedH: number): 0 | 90 | 270 {
  const turn = quarterTurn(orientation);
  if (!turn || !(width > 0 && height > 0 && decodedW > 0 && decodedH > 0)) return 0;
  return width >= height === decodedW >= decodedH ? turn : 0;
}

// A decoded tile whose shown aspect is more than 10 % off the predicted one re-lays out its row.
export function needsRelayout(predicted: number, decodedW: number, decodedH: number, rotate: number): boolean {
  if (!(predicted > 0 && decodedW > 0 && decodedH > 0)) return false;
  const shown = rotate % 180 ? decodedH / decodedW : decodedW / decodedH;
  return Math.abs(shown / predicted - 1) > 0.1;
}

// An Emby/Jellyfin Photo or Video item as a timeline asset. Coordinates only with withLocation (the map is on).
export function toAsset(item: BaseItem, offsetMin?: number, withLocation = false): PhotoAsset {
  const tag = item.ImageTags?.Primary;
  const a: PhotoAsset = {
    id: item.Id,
    serverId: item.ServerId ?? "",
    kind: item.Type === "Video" || item.MediaType === "Video" ? "video" : "photo",
    takenAt: takenAt(item.PremiereDate, item.DateCreated, offsetMin) ?? "0001-01-01T00:00:00",
    aspect: displayAspect(item.Width, item.Height, item.ImageOrientation, item.PrimaryImageAspectRatio),
    rotate: 0,
    favorite: item.UserData?.IsFavorite === true,
  };
  if (item.RunTimeTicks) a.durationMs = Math.floor(item.RunTimeTicks / 10_000);
  if (tag) a.thumbTag = tag;
  const hash = tag ? item.ImageBlurHashes?.Primary?.[tag] : undefined;
  if (hash) a.blurHash = hash;
  if (withLocation && item.Latitude != null && item.Longitude != null) {
    a.lat = item.Latitude;
    a.lon = item.Longitude;
  }
  return a;
}
