// 오프라인 전술 지도 — Canvas 2D 자체 렌더링 (외부 타일 서버 없음)
// 좌표: 기준점 중심 국지 평면(m) → 화면 픽셀. 레이어: 지형 → 그리드 → 공역 → 경로 → 궤적 → 차량/기체
import { LocalProjection, haversine, bearing, fmtDist, fmtBrg, fmtLL } from "./geo.js";

const C = {
  bg: "#0a1216", grid: "rgba(90,130,150,.16)", gridLabel: "#5d7686",
  hill: "rgba(74,96,62,.30)", contour: "rgba(128,160,104,.38)", water: "rgba(28,78,118,.55)",
  river: "rgba(48,118,178,.85)", road: "#5b5446", roadMid: "rgba(200,180,120,.35)",
  nfz: "#ff4f4a", fence: "#f0b03a", comm: "rgba(56,198,230,.55)", ring: "rgba(56,198,230,.13)",
  route: "#38c6e6", routeEdit: "#7fe3fa", wp: "#38c6e6", wpSel: "#f0b03a", leg: "#3fd68a",
  aircraft: "#3fd68a", lost: "#8a99a3", trail: "rgba(63,214,138,.55)", gcs: "#e8f6fb", replay: "#ff9f43",
};

export class TacticalMap {
  constructor(canvas, readout) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.readout = readout;
    this.proj = new LocalProjection(36.14, 128.39);
    this.cx = 0; this.cy = 0; this.mpp = 7;          // 중심(m)과 m/pixel
    this.zones = []; this.commRadius = 5000;
    this.state = null; this.trail = [];
    this.follow = true; this.edit = false;
    this.wps = []; this.home = null; this.selWp = -1; this.onWpChange = null; this.onFollowChange = null;
    this.replay = null;
    this.cursor = null;
    this.dirty = true;
    this._hatch = this._makeHatch();
    this._bind();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();
    const loop = () => { if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---- 외부 API -----------------------------------------------------------
  setReference(lat, lon) { this.proj = new LocalProjection(lat, lon); this.cx = this.cy = 0; this.dirty = true; }
  setZones(zones, commRadius) {
    this.zones = zones.map((z) => ({ ...z, xy: z.geometry.map(([la, lo]) => this.proj.toXY(la, lo)) }));
    this.commRadius = commRadius;
    this.dirty = true;
  }
  update(state) {
    this.state = state;
    const t = state?.telemetry;
    if (t?.lat != null) {
      const p = this.proj.toXY(t.lat, t.lon);
      const last = this.trail[this.trail.length - 1];
      if (t.armed && (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 2)) {
        this.trail.push(p);
        if (this.trail.length > 4000) this.trail.splice(0, 500);
      }
      if (this.follow) { this.cx = p[0]; this.cy = p[1]; }
    }
    this.dirty = true;
  }
  setMission(wps, home, editable) {
    this.wps = (wps || []).map((w) => ({ ...w }));
    this.home = home;
    this.editable = !!editable;
    if (this.selWp >= this.wps.length) this.selWp = -1;
    this.dirty = true;
  }
  setEdit(on) { this.edit = on; this.c.classList.toggle("editing", on); this.dirty = true; }
  setFollow(on) { this.follow = on; this.onFollowChange?.(on); if (on && this.state) this.update(this.state); this.dirty = true; }
  clearTrail() { this.trail = []; this.dirty = true; }
  setReplay(track, idx) { this.replay = track ? { track, idx } : null; this.dirty = true; }
  fit() {
    const fence = this.zones.find((z) => z.kind === "GEOFENCE");
    const pts = fence ? fence.xy : [[-3000, -3000], [3000, 3000]];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    this.cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    this.cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    this.mpp = Math.max((Math.max(...xs) - Math.min(...xs)) / (this.w - 40), (Math.max(...ys) - Math.min(...ys)) / (this.h - 40));
    this.setFollow(false);
  }
  focus(lat, lon) { [this.cx, this.cy] = this.proj.toXY(lat, lon); this.dirty = true; }

  // ---- 좌표 변환 ------------------------------------------------------------
  w2s(x, y) { return [this.w / 2 + (x - this.cx) / this.mpp, this.h / 2 - (y - this.cy) / this.mpp]; }
  s2w(sx, sy) { return [this.cx + (sx - this.w / 2) * this.mpp, this.cy - (sy - this.h / 2) * this.mpp]; }
  ll2s(lat, lon) { const [x, y] = this.proj.toXY(lat, lon); return this.w2s(x, y); }

  _resize() {
    const r = this.c.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.c.width = Math.round(this.w * this.dpr); this.c.height = Math.round(this.h * this.dpr);
    this.dirty = true;
  }

  _makeHatch() {
    const p = document.createElement("canvas"); p.width = p.height = 10;
    const g = p.getContext("2d");
    g.strokeStyle = "rgba(255,79,74,.42)"; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(0, 10); g.lineTo(10, 0); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(8, 12); g.lineTo(12, 8); g.stroke();
    return this.ctx.createPattern(p, "repeat");
  }

  // ---- 입력 ----------------------------------------------------------------
  _hitWp(sx, sy) {
    for (let i = this.wps.length - 1; i >= 0; i--) {
      const [x, y] = this.ll2s(this.wps[i].lat, this.wps[i].lon);
      if (Math.hypot(x - sx, y - sy) <= 11) return i;
    }
    return -1;
  }
  _bind() {
    const c = this.c;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    let drag = null;
    c.addEventListener("pointerdown", (e) => {
      const [sx, sy] = pos(e);
      c.setPointerCapture(e.pointerId);
      const hit = this.edit && this.editable ? this._hitWp(sx, sy) : -1;
      if (e.button === 2) return;
      if (hit >= 0) { drag = { kind: "wp", i: hit, moved: false }; this.selWp = hit; }
      else drag = { kind: "pan", sx, sy, cx: this.cx, cy: this.cy, moved: false };
      this.dirty = true;
    });
    c.addEventListener("pointermove", (e) => {
      const [sx, sy] = pos(e);
      this.cursor = this.s2w(sx, sy);
      this._updateReadout();
      if (!drag) return;
      if (drag.kind === "pan") {
        const dx = sx - drag.sx, dy = sy - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        if (!drag.moved) { drag.moved = true; c.classList.add("dragging"); if (this.follow) this.setFollow(false); }
        this.cx = drag.cx - dx * this.mpp; this.cy = drag.cy + dy * this.mpp;
      } else {
        drag.moved = true;
        const [lat, lon] = this.proj.toLL(...this.s2w(sx, sy));
        this.wps[drag.i].lat = +lat.toFixed(6); this.wps[drag.i].lon = +lon.toFixed(6);
        this.onWpChange?.(this.wps, { live: true, index: drag.i });
      }
      this.dirty = true;
    });
    c.addEventListener("pointerup", (e) => {
      const [sx, sy] = pos(e);
      c.classList.remove("dragging");
      if (drag?.kind === "wp" && drag.moved) this.onWpChange?.(this.wps, { live: false, index: drag.i });
      else if (drag?.kind === "pan" && !drag.moved && this.edit && this.editable && e.button === 0) {
        const [lat, lon] = this.proj.toLL(...this.s2w(sx, sy));
        const prev = this.wps[this.wps.length - 1];
        this.wps.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), alt: prev?.alt ?? 60, speed: prev?.speed ?? 10, hold: 0, action: "WAYPOINT" });
        this.selWp = this.wps.length - 1;
        this.onWpChange?.(this.wps, { live: false, added: true });
      }
      drag = null; this.dirty = true;
    });
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!(this.edit && this.editable)) return;
      const [sx, sy] = pos(e);
      const i = this._hitWp(sx, sy);
      if (i >= 0) { this.wps.splice(i, 1); this.selWp = -1; this.onWpChange?.(this.wps, { live: false, removed: i }); this.dirty = true; }
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const before = this.s2w(sx, sy);
      this.mpp = Math.min(60, Math.max(0.25, this.mpp * Math.pow(1.0015, e.deltaY)));
      const after = this.s2w(sx, sy);
      if (!this.follow) { this.cx += before[0] - after[0]; this.cy += before[1] - after[1]; }
      this.dirty = true;
    }, { passive: false });
    c.addEventListener("pointerleave", () => { this.cursor = null; this._updateReadout(); });
    c.addEventListener("keydown", (e) => {
      const step = 60 * this.mpp;
      const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (k) { e.preventDefault(); this.setFollow(false); this.cx += k[0]; this.cy += k[1]; this.dirty = true; }
      if (e.key === "+" || e.key === "=") { this.mpp = Math.max(0.25, this.mpp / 1.25); this.dirty = true; }
      if (e.key === "-") { this.mpp = Math.min(60, this.mpp * 1.25); this.dirty = true; }
    });
  }

  _updateReadout() {
    const lines = [];
    const g = this.state?.gcs;
    if (this.cursor) {
      const [lat, lon] = this.proj.toLL(...this.cursor);
      lines.push(`커서  ${fmtLL(lat, lon)}`);
      if (g) lines.push(`차량→커서 ${fmtDist(haversine(g.lat, g.lon, lat, lon))} / ${fmtBrg(bearing(g.lat, g.lon, lat, lon))}`);
    }
    const rel = this.state?.relative;
    if (rel) lines.push(`차량→기체 ${fmtDist(rel.distance_m)} / ${fmtBrg(rel.bearing_deg)}`);
    lines.push(`축척 ${this.mpp.toFixed(1)} m/px`);
    this.readout.textContent = lines.join("\n");
  }

  // ---- 렌더링 ----------------------------------------------------------------
  draw() {
    const g = this.ctx, w = this.w, h = this.h;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
    this._terrain(g);
    this._grid(g);
    this._rings(g);
    this._airspace(g);
    this._mission(g);
    this._replay(g);
    this._vehicles(g);
    this._chrome(g);
    this._updateReadout();
  }

  _path(g, xy, close) {
    g.beginPath();
    xy.forEach(([x, y], i) => { const [sx, sy] = this.w2s(x, y); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
    if (close) g.closePath();
  }
  _centroid(xy) {
    const n = xy.length; return [xy.reduce((s, p) => s + p[0], 0) / n, xy.reduce((s, p) => s + p[1], 0) / n];
  }
  _label(g, text, sx, sy, color, align = "center", bg = true) {
    g.font = "600 11.5px Segoe UI, Malgun Gothic, sans-serif";
    g.textAlign = align; g.textBaseline = "middle";
    if (bg) {
      const m = g.measureText(text).width;
      const x0 = align === "center" ? sx - m / 2 : align === "left" ? sx : sx - m;
      g.fillStyle = "rgba(6,12,16,.72)"; g.fillRect(x0 - 4, sy - 9, m + 8, 18);
    }
    g.fillStyle = color; g.fillText(text, sx, sy);
  }

  _terrain(g) {
    for (const z of this.zones.filter((z) => z.kind === "TERRAIN")) {
      const t = z.props?.type;
      if (t === "hill") {
        const c0 = this._centroid(z.xy);
        g.fillStyle = C.hill; this._path(g, z.xy, true); g.fill();
        g.strokeStyle = C.contour; g.lineWidth = 1;
        for (const k of [1, 0.72, 0.46, 0.22]) {
          this._path(g, z.xy.map(([x, y]) => [c0[0] + (x - c0[0]) * k, c0[1] + (y - c0[1]) * k]), true); g.stroke();
        }
        if (this.mpp < 14) { const [sx, sy] = this.w2s(...c0); this._label(g, `▲ ${z.name} ${z.props.elev ?? ""}m`, sx, sy, "#a9c48f", "center", false); }
      } else if (t === "water") {
        g.fillStyle = C.water; this._path(g, z.xy, true); g.fill();
      } else if (t === "river") {
        g.strokeStyle = C.river; g.lineWidth = Math.max(2, 28 / this.mpp); g.lineJoin = g.lineCap = "round";
        this._path(g, z.xy); g.stroke();
      } else if (t === "road") {
        g.strokeStyle = C.road; g.lineWidth = Math.max(1.5, 9 / this.mpp); g.lineCap = "round";
        this._path(g, z.xy); g.stroke();
        if (this.mpp < 6) { g.setLineDash([6, 6]); g.strokeStyle = C.roadMid; g.lineWidth = 1; this._path(g, z.xy); g.stroke(); g.setLineDash([]); }
      }
    }
  }

  _grid(g) {
    const steps = [0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1];
    const ky = this.proj.ky;
    const step = steps.find((s) => (s * ky) / this.mpp >= 85) ?? 0.1;
    const dec = step < 0.001 ? 4 : step < 0.01 ? 3 : 2;
    const [la0, lo0] = this.proj.toLL(...this.s2w(0, this.h));
    const [la1, lo1] = this.proj.toLL(...this.s2w(this.w, 0));
    g.strokeStyle = C.grid; g.lineWidth = 1;
    g.font = "10.5px Consolas, Menlo, monospace"; g.fillStyle = C.gridLabel;
    for (let la = Math.ceil(la0 / step) * step; la <= la1; la += step) {
      const [, sy] = this.ll2s(la, lo0);
      g.beginPath(); g.moveTo(0, sy); g.lineTo(this.w, sy); g.stroke();
      g.textAlign = "left"; g.textBaseline = "bottom"; g.fillText(`${la.toFixed(dec)}°N`, 4, sy - 2);
    }
    for (let lo = Math.ceil(lo0 / step) * step; lo <= lo1; lo += step) {
      const [sx] = this.ll2s(la0, lo);
      g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, this.h); g.stroke();
      g.textAlign = "left"; g.textBaseline = "bottom"; g.fillText(`${lo.toFixed(dec)}°E`, sx + 3, this.h - 3);
    }
  }

  _rings(g) {
    const gc = this.state?.gcs; if (!gc) return;
    const [sx, sy] = this.ll2s(gc.lat, gc.lon);
    g.strokeStyle = C.ring; g.lineWidth = 1;
    g.font = "10.5px Consolas, Menlo, monospace"; g.fillStyle = "rgba(120,190,210,.55)"; g.textAlign = "left";
    for (let r = 1000; r < this.commRadius; r += 1000) {
      g.beginPath(); g.arc(sx, sy, r / this.mpp, 0, Math.PI * 2); g.stroke();
      g.fillText(`${r / 1000}km`, sx + 3, sy - r / this.mpp - 3);
    }
    g.strokeStyle = C.comm; g.setLineDash([10, 6]); g.lineWidth = 1.6;
    g.beginPath(); g.arc(sx, sy, this.commRadius / this.mpp, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    this._label(g, `통신 유효반경 ${this.commRadius / 1000}km`, sx, sy - this.commRadius / this.mpp - 11, "#7fe3fa");
  }

  _airspace(g) {
    for (const z of this.zones) {
      if (z.kind === "GEOFENCE") {
        g.strokeStyle = C.fence; g.lineWidth = 2; g.setLineDash([9, 6]);
        this._path(g, z.xy, true); g.stroke(); g.setLineDash([]);
        const top = z.xy.reduce((a, b) => (b[1] > a[1] ? b : a));
        const [sx, sy] = this.w2s(...top); this._label(g, `지오펜스 · ${z.name}`, sx, sy - 12, C.fence);
      } else if (z.kind === "NFZ") {
        g.fillStyle = this._hatch; this._path(g, z.xy, true); g.fill();
        g.fillStyle = "rgba(255,79,74,.08)"; g.fill();
        g.strokeStyle = C.nfz; g.lineWidth = 1.8; g.stroke();
        const [sx, sy] = this.w2s(...this._centroid(z.xy));
        this._label(g, `NFZ ${z.name}`, sx, sy, "#ff8f8b");
      }
    }
  }

  _mission(g) {
    const pts = this.wps; if (!pts.length) return;
    const home = this.home;
    const seq = (home ? [home] : []).concat(pts);
    const scr = seq.map((p) => this.ll2s(p.lat, p.lon));
    g.lineWidth = this.edit ? 2.6 : 2; g.strokeStyle = this.edit ? C.routeEdit : C.route;
    g.beginPath(); scr.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    if (home && pts[pts.length - 1].action !== "LAND") {
      const [lx, ly] = scr[scr.length - 1], [hx, hy] = scr[0];
      g.setLineDash([4, 5]); g.beginPath(); g.moveTo(lx, ly); g.lineTo(hx, hy); g.stroke(); g.setLineDash([]);
    }
    // 구간 거리/방위
    for (let i = 1; i < seq.length; i++) {
      const [ax, ay] = scr[i - 1], [bx, by] = scr[i];
      if (Math.hypot(bx - ax, by - ay) < 110) continue;
      const d = haversine(seq[i - 1].lat, seq[i - 1].lon, seq[i].lat, seq[i].lon);
      const b = bearing(seq[i - 1].lat, seq[i - 1].lon, seq[i].lat, seq[i].lon);
      this._label(g, `${fmtDist(d)} ${fmtBrg(b)}`, (ax + bx) / 2, (ay + by) / 2, "#9fdcec");
    }
    // 현재 수행 구간 강조
    const leg = this.state?.telemetry?.mission_leg;
    if (leg) {
      const [a, b] = leg.map(([la, lo]) => this.ll2s(la, lo));
      g.strokeStyle = C.leg; g.lineWidth = 4; g.globalAlpha = 0.6;
      g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); g.globalAlpha = 1;
    }
    pts.forEach((p, i) => {
      const [x, y] = scr[i + (home ? 1 : 0)];
      const sel = i === this.selWp;
      g.fillStyle = sel ? C.wpSel : "#0b2630"; g.strokeStyle = sel ? C.wpSel : C.wp; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = sel ? "#1a1200" : "#bdf2ff"; g.font = "700 10.5px Consolas, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(i + 1), x, y + 0.5);
      if (this.mpp < 12) this._label(g, `${p.alt}m${p.action !== "WAYPOINT" ? " " + p.action : ""}`, x, y + 18, "#9fdcec", "center", true);
    });
  }

  _replay(g) {
    if (!this.replay?.track?.length) return;
    const { track, idx } = this.replay;
    g.strokeStyle = C.replay; g.lineWidth = 2; g.globalAlpha = 0.85;
    this._path(g, track.map((p) => p.xy)); g.stroke(); g.globalAlpha = 1;
    const p = track[Math.min(idx, track.length - 1)];
    if (p) this._aircraftIcon(g, ...this.w2s(...p.xy), p.heading || 0, C.replay, `재생 ${p.alt_rel?.toFixed?.(0) ?? "-"}m`);
  }

  _aircraftIcon(g, sx, sy, hdg, color, label) {
    g.save(); g.translate(sx, sy); g.rotate((hdg * Math.PI) / 180);
    g.fillStyle = color; g.strokeStyle = "#04140c"; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, -15); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath(); g.fill(); g.stroke();
    g.restore();
    g.strokeStyle = color; g.globalAlpha = 0.35; g.lineWidth = 1;
    g.beginPath(); g.arc(sx, sy, 20, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    if (label) this._label(g, label, sx + 24, sy - 14, color, "left");
  }

  _vehicles(g) {
    const s = this.state; if (!s) return;
    const t = s.telemetry || {};
    // 궤적
    if (this.trail.length > 1) {
      g.strokeStyle = C.trail; g.lineWidth = 2;
      this._path(g, this.trail); g.stroke();
    }
    // 이착륙 지점
    if (t.home?.lat) {
      const [hx, hy] = this.ll2s(t.home.lat, t.home.lon);
      g.strokeStyle = "#f0b03a"; g.lineWidth = 1.5; g.beginPath(); g.arc(hx, hy, 8, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "#f0b03a"; g.font = "700 10px Consolas"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("H", hx, hy + 0.5);
    }
    // 통제 차량 + 기체 연결선
    const gc = s.gcs;
    let gs = null;
    if (gc) gs = this.ll2s(gc.lat, gc.lon);
    if (gs && t.lat != null) {
      const as = this.ll2s(t.lat, t.lon);
      g.strokeStyle = "rgba(232,246,251,.45)"; g.setLineDash([3, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(...gs); g.lineTo(...as); g.stroke(); g.setLineDash([]);
      if (s.relative && Math.hypot(as[0] - gs[0], as[1] - gs[1]) > 70)
        this._label(g, `차량↔기체 ${fmtDist(s.relative.distance_m)} ${fmtBrg(s.relative.bearing_deg)}`, (gs[0] + as[0]) / 2 + 12, (gs[1] + as[1]) / 2 + 16, "#e8f6fb", "left");
    }
    if (gs) {
      g.save(); g.translate(...gs);
      g.fillStyle = "#1b2c36"; g.strokeStyle = C.gcs; g.lineWidth = 1.6;
      g.fillRect(-11, -7, 22, 14); g.strokeRect(-11, -7, 22, 14);
      g.fillStyle = C.gcs; g.font = "700 9px Consolas"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("C2", 0, 0.5);
      g.restore();
      this._label(g, "통제차량", gs[0], gs[1] + 18, C.gcs);
    }
    if (t.lat != null) {
      const lost = !s.link?.connected;
      const [ax, ay] = this.ll2s(t.lat, t.lon);
      const label = `${s.aircraft?.id || "UAV"} ${(t.alt_rel ?? 0).toFixed(0)}m ${(t.groundspeed ?? 0).toFixed(1)}m/s${lost ? " · LINK LOST" : ""}`;
      this._aircraftIcon(g, ax, ay, t.heading || 0, lost ? C.lost : C.aircraft, label);
    }
  }

  _chrome(g) {
    // 축척 막대
    const target = 120 * this.mpp;
    const nice = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((v) => v >= target * 0.6) || 5000;
    const px = nice / this.mpp, x0 = 12, y0 = this.h - 24;
    g.fillStyle = "rgba(6,12,16,.75)"; g.fillRect(x0 - 6, y0 - 16, px + 60, 26);
    g.strokeStyle = "#cfdbe3"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x0, y0 - 5); g.lineTo(x0, y0); g.lineTo(x0 + px, y0); g.lineTo(x0 + px, y0 - 5); g.stroke();
    g.fillStyle = "#cfdbe3"; g.font = "11px Consolas"; g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.fillText(fmtDist(nice), x0 + px + 6, y0);
    // 방위표
    const nx = this.w - 26, ny = 54;
    g.fillStyle = "rgba(6,12,16,.75)"; g.beginPath(); g.arc(nx, ny, 17, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#ff8f8b"; g.beginPath(); g.moveTo(nx, ny - 13); g.lineTo(nx + 5, ny); g.lineTo(nx - 5, ny); g.fill();
    g.fillStyle = "#cfdbe3"; g.beginPath(); g.moveTo(nx, ny + 13); g.lineTo(nx + 5, ny); g.lineTo(nx - 5, ny); g.fill();
    g.font = "700 10px Consolas"; g.textAlign = "center"; g.fillText("N", nx, ny - 21 + 2);
  }
}
