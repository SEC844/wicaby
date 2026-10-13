// Photos (spec PH-01, F9): the EXIF panel's values. Kotlin twin: core photos/Exif.kt (same fixtures). The unit
// templates are the photos.exif.*Value strings (core photos_exif_*_value on Android).
import type { BaseItem } from "../../../shared/models";

export interface Exif {
  make?: string;
  model?: string;
  software?: string;
  exposureS?: number;
  focalMm?: number;
  // As the server sends it: APEX on Jellyfin (TagLib's ApertureValue), unverified on Emby (gate G2).
  apertureAv?: number;
  iso?: number;
  lat?: number;
  lon?: number;
  alt?: number;
  width?: number;
  height?: number;
  orientation?: string;
}

export interface ExifTemplates {
  aperture: string;
  exposure: string;
  focal: string;
  iso: string;
  dimensions: string;
  altitude: string;
  location: string;
}

// "hidden" until gate G2 confirms the server's unit (spec §3.1). ShutterSpeed (APEX too) is never shown:
// ExposureTime is in seconds on both servers.
export type ApertureUnit = "hidden" | "apex" | "fnumber";

export function exifOf(item: BaseItem): Exif {
  return {
    make: item.CameraMake,
    model: item.CameraModel,
    software: item.Software,
    exposureS: item.ExposureTime,
    focalMm: item.FocalLength,
    apertureAv: item.Aperture,
    iso: item.IsoSpeedRating,
    lat: item.Latitude,
    lon: item.Longitude,
    alt: item.Altitude,
    width: item.Width,
    height: item.Height,
    orientation: item.ImageOrientation,
  };
}

// Rounded to `digits`, trailing zeros dropped, decimal comma in French. toFixed rounds the exact value half up, as
// Kotlin's BigDecimal HALF_UP does; the sign goes on separately so both round negatives alike.
function num(x: number, digits: number, lang: string): string {
  let s = Math.abs(x).toFixed(digits);
  if (digits > 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (x < 0 && /[1-9]/.test(s)) s = `-${s}`;
  return lang === "fr" ? s.replace(".", ",") : s;
}

const fill = (tpl: string, values: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
const ok = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
const QUARTER = ["RightTop", "LeftTop", "LeftBottom", "RightBottom"];

// [label key, value] pairs in panel order, for the fields present. Label keys: photos.exif.<key>.
export function formatExif(e: Exif, lang: "fr" | "en", tpl: ExifTemplates, aperture: ApertureUnit = "hidden"): [string, string][] {
  const out: [string, string][] = [];
  const make = e.make?.trim() ?? "";
  const model = e.model?.trim() ?? "";
  const camera = make && model && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model || make;
  if (camera) out.push(["camera", camera]);
  if (ok(e.exposureS) && e.exposureS > 0)
    out.push(["exposure", fill(tpl.exposure, { value: e.exposureS >= 0.5 ? num(e.exposureS, 1, lang) : `1/${Math.floor(1 / e.exposureS + 0.5)}` })]);
  if (aperture !== "hidden" && ok(e.apertureAv) && e.apertureAv > 0)
    out.push(["aperture", fill(tpl.aperture, { value: num(aperture === "apex" ? Math.pow(2, e.apertureAv / 2) : e.apertureAv, 1, lang) })]);
  if (ok(e.focalMm) && e.focalMm > 0) out.push(["focal", fill(tpl.focal, { value: num(e.focalMm, 1, lang) })]);
  if (ok(e.iso) && e.iso > 0) out.push(["iso", fill(tpl.iso, { value: String(Math.round(e.iso)) })]);
  if (ok(e.width) && ok(e.height) && e.width > 0 && e.height > 0) {
    const turned = QUARTER.includes(e.orientation ?? "");
    out.push(["dimensions", fill(tpl.dimensions, { w: String(turned ? e.height : e.width), h: String(turned ? e.width : e.height) })]);
  }
  if (ok(e.alt)) out.push(["altitude", fill(tpl.altitude, { value: num(e.alt, 0, lang) })]);
  if (ok(e.lat) && ok(e.lon)) out.push(["location", fill(tpl.location, { lat: num(e.lat, 4, lang), lon: num(e.lon, 4, lang) })]);
  const software = e.software?.trim();
  if (software) out.push(["software", software]);
  return out;
}
