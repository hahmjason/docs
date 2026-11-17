// 클라이언트 측 측지 계산 (서버 ugcs/geo.py와 같은 식)
export const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(lat1, lon1, lat2, lon2) {
  const dp = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const x = Math.sin(dl) * Math.cos(p2);
  const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(x, y)) + 360) % 360;
}

export function destination(lat, lon, brg, dist) {
  const d = dist / R, b = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/** 기준점 중심 국지 평면(m): x=동, y=북 */
export class LocalProjection {
  constructor(lat0, lon0) {
    this.lat0 = lat0; this.lon0 = lon0;
    this.kx = rad(1) * R * Math.cos(rad(lat0));
    this.ky = rad(1) * R;
  }
  toXY(lat, lon) { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]; }
  toLL(x, y) { return [this.lat0 + y / this.ky, this.lon0 + x / this.kx]; }
}

export const fmtDist = (m) => (m == null ? "—" : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
export const fmtBrg = (b) => (b == null ? "—" : `${String(Math.round(b) % 360).padStart(3, "0")}°`);
export const fmtLL = (lat, lon) => `${lat.toFixed(5)}°${lat >= 0 ? "N" : "S"} ${lon.toFixed(5)}°${lon >= 0 ? "E" : "W"}`;
export function fmtDur(s) {
  if (s == null) return "—";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}
