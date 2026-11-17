// 영상 패널: 영상 소스 어댑터 + HUD 오버레이
//  - VideoSource 인터페이스: start() / stop() / render(ctx, w, h, view) / live
//  - SimulatedEoIrSource : 텔레메트리·지형 데이터로 그린 모의 EO/IR 화면 (기본)
//  - MjpegSource         : 로컬 MJPEG(HTTP) 스트림 — 같은 출처 URL만 허용(CSP)
//  - WebRtcSource        : 로컬 WHEP 게이트웨이(RTSP→WebRTC 변환)용 자리표시 어댑터
// 실제 장비 연동 시 소스만 교체하면 HUD와 패널은 그대로 사용된다.
import { fmtDist } from "./geo.js";

const HUD = "#8dffb0";
const rad = (d) => (d * Math.PI) / 180;

export class VideoSource {
  constructor(id, label) { this.id = id; this.label = label; }
  start() {}
  stop() {}
  get live() { return true; }
  render() {}
}

// ---------------------------------------------------------------------------
function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export class SimulatedEoIrSource extends VideoSource {
  constructor(proj) {
    super("sim", "시뮬레이션 EO/IR (내장)");
    this.proj = proj;
    this.zones = [];
    this.off = document.createElement("canvas");
    this.offCtx = this.off.getContext("2d");
    this.groundTex = this._noiseTex(256, [[74, 88, 52], [92, 104, 60], [66, 76, 48], [104, 98, 66]], 7);
    this.grain = this._grain(256);
    this.buildings = [];
  }
  setZones(zones, proj) {
    this.proj = proj;
    this.zones = zones.map((z) => ({ ...z, xy: z.geometry.map(([a, b]) => proj.toXY(a, b)) }));
    // 금지구역 내부에 결정적(seeded) 건물 배치
    this.buildings = [];
    const rnd = seeded(99);
    for (const z of this.zones.filter((z) => z.kind === "NFZ")) {
      const xs = z.xy.map((p) => p[0]), ys = z.xy.map((p) => p[1]);
      for (let i = 0; i < 70; i++) {
        const x = Math.min(...xs) + rnd() * (Math.max(...xs) - Math.min(...xs));
        const y = Math.min(...ys) + rnd() * (Math.max(...ys) - Math.min(...ys));
        if (inside([x, y], z.xy)) this.buildings.push({ x, y, w: 8 + rnd() * 18, h: 8 + rnd() * 14, a: rnd() * 90, hot: rnd() < 0.18 });
      }
    }
  }
  _noiseTex(n, palette, seed) {
    const c = document.createElement("canvas"); c.width = c.height = n;
    const g = c.getContext("2d"), img = g.createImageData(n, n), rnd = seeded(seed);
    // 저주파 + 고주파 혼합 잡음 (경작지/수풀 질감)
    const coarse = Array.from({ length: 17 * 17 }, () => rnd());
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const gx = (x / n) * 16, gy = (y / n) * 16, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const v = coarse[iy * 17 + ix] * (1 - fx) * (1 - fy) + coarse[iy * 17 + ix + 1] * fx * (1 - fy) +
        coarse[(iy + 1) * 17 + ix] * (1 - fx) * fy + coarse[(iy + 1) * 17 + ix + 1] * fx * fy;
      const p = palette[Math.min(palette.length - 1, Math.floor(v * palette.length))];
      const j = (rnd() - 0.5) * 22, k = (y * n + x) * 4;
      img.data[k] = p[0] + j; img.data[k + 1] = p[1] + j; img.data[k + 2] = p[2] + j; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  _grain(n) {
    const c = document.createElement("canvas"); c.width = c.height = n;
    const g = c.getContext("2d"), img = g.createImageData(n, n);
    for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    return c;
  }

  render(ctx, w, h, view) {
    const { state, mode, t } = view;
    const tel = state?.telemetry;
    if (!tel || tel.lat == null) { noSignal(ctx, w, h, "영상 대기 — 텔레메트리 없음"); return null; }
    if (!state.link?.connected && this._lastFrame) {      // 링크 단절: 마지막 프레임 정지 + 노이즈
      ctx.drawImage(this._lastFrame, 0, 0, w, h);
      ctx.globalAlpha = 0.35; ctx.drawImage(this.grain, Math.random() * -60, Math.random() * -60, w + 60, h + 60); ctx.globalAlpha = 1;
      return this._lastGeo;
    }
    const alt = Math.max(1.5, tel.alt_rel ?? 0);
    const gp = Math.min(-5, tel.gimbal?.pitch ?? -30);           // 아래쪽이 음수
    const az = ((tel.heading ?? 0) + (tel.gimbal?.yaw ?? 0) + 360) % 360;
    const vfov = rad(42);
    const D = Math.min(3000, alt / Math.tan(rad(-gp)));
    const slant = Math.hypot(alt, D);
    const ppm = (h / 2) / (slant * Math.tan(vfov / 2));
    const k = Math.max(0.25, Math.sin(rad(-gp)));
    const [ax, ay] = this.proj.toXY(tel.lat, tel.lon);
    const cx = ax + D * Math.sin(rad(az)), cy = ay + D * Math.cos(rad(az));

    const off = this.off, g = this.offCtx;
    if (off.width !== w || off.height !== h) { off.width = w; off.height = h; }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#6b7650"; g.fillRect(0, 0, w, h);
    g.save();
    g.translate(w / 2, h / 2); g.scale(ppm, ppm * k); g.rotate(-rad(az)); g.translate(-cx, cy);
    const ext = Math.hypot(w, h) / ppm / k;
    // 지면 질감 (1 px = 0.5 m)
    const pat = g.createPattern(this.groundTex, "repeat");
    pat.setTransform(new DOMMatrix().scale(0.5, 0.5));
    g.fillStyle = pat; g.fillRect(cx - ext, -cy - ext, ext * 2, ext * 2);
    const path = (xy, close) => { g.beginPath(); xy.forEach(([x, y], i) => (i ? g.lineTo(x, -y) : g.moveTo(x, -y))); if (close) g.closePath(); };
    for (const z of this.zones) {
      const ty = z.props?.type;
      if (ty === "hill") { g.fillStyle = "rgba(46,60,34,.55)"; path(z.xy, true); g.fill(); }
      else if (ty === "water") { g.fillStyle = "#2c4a5c"; path(z.xy, true); g.fill(); }
      else if (ty === "river") { g.strokeStyle = "#35566a"; g.lineWidth = 34; g.lineJoin = g.lineCap = "round"; path(z.xy); g.stroke(); }
      else if (ty === "road") {
        g.strokeStyle = "#8a8578"; g.lineWidth = 8; g.lineCap = "round"; path(z.xy); g.stroke();
        g.strokeStyle = "rgba(240,230,190,.5)"; g.lineWidth = 0.4; g.setLineDash([3, 4]); path(z.xy); g.stroke(); g.setLineDash([]);
      } else if (z.kind === "NFZ") { g.fillStyle = "rgba(120,112,98,.55)"; path(z.xy, true); g.fill(); }
    }
    for (const b of this.buildings) {
      g.save(); g.translate(b.x, -b.y); g.rotate(rad(b.a));
      g.fillStyle = "#b9b2a4"; g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(-b.w / 2 + 1.5, b.h / 2, b.w, 2.5);
      g.restore();
    }
    // 이동 표적 (도로 위 차량) — IR에서 고온체로 표시
    const hot = [];
    const roads = this.zones.filter((z) => z.props?.type === "road");
    roads.forEach((r, ri) => {
      for (let n = 0; n < 3; n++) {
        const p = alongPath(r.xy, ((t / 1000) * (9 + n * 2) + n * 900 + ri * 450));
        if (!p) continue;
        g.save(); g.translate(p[0], -p[1]); g.rotate(rad(p[2]));
        g.fillStyle = ["#41503a", "#2b3742", "#5a4b36"][n]; g.fillRect(-1.2, -2.4, 2.4, 4.8);
        g.restore();
        hot.push([p[0], p[1], 3.2]);
      }
    });
    const gc = state.gcs;
    if (gc) {
      const [gx, gy] = this.proj.toXY(gc.lat, gc.lon);
      g.fillStyle = "#3b4430"; g.fillRect(gx - 4, -gy - 2, 8, 4.5); g.fillStyle = "#59624a"; g.fillRect(gx - 4, -gy - 2, 3, 4.5);
      hot.push([gx, gy, 5]);
    }
    this.buildings.filter((b) => b.hot).forEach((b) => hot.push([b.x, b.y, 3]));
    g.restore();

    // 수평선/대기 (짐벌을 얕게 들수록 하늘 노출)
    const horizonY = h / 2 - (Math.abs(gp) / (42 / 2)) * (h / 2);
    if (horizonY > -h * 0.1) {
      const hy = Math.max(0, horizonY);
      const sky = g.createLinearGradient(0, 0, 0, hy + 40);
      sky.addColorStop(0, "#7d9db4"); sky.addColorStop(1, "#c4ccc8");
      g.fillStyle = sky; g.fillRect(0, 0, w, hy);
      const haze = g.createLinearGradient(0, hy, 0, hy + h * 0.25);
      haze.addColorStop(0, "rgba(196,204,200,.85)"); haze.addColorStop(1, "rgba(196,204,200,0)");
      g.fillStyle = haze; g.fillRect(0, hy, w, h * 0.25);
    }

    ctx.save();
    if (mode === "IR") {
      ctx.filter = "grayscale(1) brightness(.62) contrast(1.5)";
      ctx.drawImage(off, 0, 0);
      ctx.filter = "none";
      ctx.translate(w / 2, h / 2); ctx.scale(ppm, ppm * k); ctx.rotate(-rad(az)); ctx.translate(-cx, cy);
      for (const [x, y, r] of hot) {
        const rg = ctx.createRadialGradient(x, -y, 0, x, -y, r * 2.2);
        rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.45, "rgba(255,255,255,.75)"); rg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, -y, r * 2.2, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      ctx.drawImage(off, 0, 0);
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = mode === "IR" ? 0.1 : 0.05;
    ctx.globalCompositeOperation = "overlay";
    ctx.drawImage(this.grain, -Math.random() * 80, -Math.random() * 80, w + 80, h + 80);
    ctx.restore();
    if (mode === "IR") { ctx.fillStyle = "rgba(0,0,0,.08)"; for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1); }

    // 마지막 프레임 보관 (링크 단절 시 정지 화면)
    if (!this._lastFrame) this._lastFrame = document.createElement("canvas");
    if (t - (this._lastSnap || 0) > 400) {
      this._lastSnap = t;
      this._lastFrame.width = ctx.canvas.width; this._lastFrame.height = ctx.canvas.height;
      this._lastFrame.getContext("2d").drawImage(ctx.canvas, 0, 0);
    }
    const [tlat, tlon] = this.proj.toLL(cx, cy);
    this._lastGeo = { lat: tlat, lon: tlon, slant, ppm };
    return this._lastGeo;
  }
}

function inside([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function alongPath(xy, dist) {
  let total = 0; const seg = [];
  for (let i = 1; i < xy.length; i++) { const d = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]); seg.push(d); total += d; }
  if (!total) return null;
  let s = ((dist % (2 * total)) + 2 * total) % (2 * total);
  const back = s > total; if (back) s = 2 * total - s;
  for (let i = 0; i < seg.length; i++) {
    if (s <= seg[i]) {
      const f = s / seg[i], a = xy[i], b = xy[i + 1];
      let hdg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
      if (back) hdg += 180;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, hdg];
    }
    s -= seg[i];
  }
  return null;
}

function noSignal(ctx, w, h, text) {
  ctx.fillStyle = "#05080a"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#6d7e88"; ctx.font = "600 14px Segoe UI, Malgun Gothic, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);
}

// ---------------------------------------------------------------------------
export class MjpegSource extends VideoSource {
  constructor(url = "/video/stream.mjpg") {
    super("mjpeg", `로컬 MJPEG (${url})`);
    this.url = url; this.img = null; this.ok = false;
  }
  start() {
    this.img = new Image();
    this.img.onload = () => (this.ok = true);
    this.img.onerror = () => (this.ok = false);
    this.img.src = this.url;           // CSP img-src 'self' → 같은 서버만 허용
  }
  stop() { if (this.img) this.img.src = ""; this.img = null; this.ok = false; }
  get live() { return this.ok; }
  render(ctx, w, h) {
    if (!this.ok) { noSignal(ctx, w, h, `MJPEG 소스 없음 — ${this.url}`); return null; }
    ctx.drawImage(this.img, 0, 0, w, h);
    return null;
  }
}

export class WebRtcSource extends VideoSource {
  // RTSP 카메라 → (차량 내 미디어 게이트웨이) → WHEP(WebRTC) → 이 어댑터. 게이트웨이가 없으면 대기 화면.
  constructor(whepUrl = "/video/whep") {
    super("webrtc", `로컬 WebRTC/WHEP (${whepUrl})`);
    this.url = whepUrl; this.video = null; this.pc = null; this.ok = false;
  }
  async start() {
    try {
      this.pc = new RTCPeerConnection({ iceServers: [] });   // 폐쇄망: STUN/TURN 없음, LAN 직결
      this.pc.addTransceiver("video", { direction: "recvonly" });
      this.video = document.createElement("video"); this.video.muted = true; this.video.playsInline = true;
      this.pc.ontrack = (e) => { this.video.srcObject = e.streams[0]; this.video.play().catch(() => {}); this.ok = true; };
      const offer = await this.pc.createOffer(); await this.pc.setLocalDescription(offer);
      const res = await fetch(this.url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer.sdp });
      if (!res.ok) throw new Error(`WHEP ${res.status}`);
      await this.pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch (e) { this.err = e.message; this.ok = false; }
  }
  stop() { this.pc?.close(); this.pc = null; this.ok = false; }
  get live() { return this.ok; }
  render(ctx, w, h) {
    if (!this.ok) { noSignal(ctx, w, h, `WebRTC 게이트웨이 미연결${this.err ? " — " + this.err : ""}`); return null; }
    ctx.drawImage(this.video, 0, 0, w, h);
    return null;
  }
}

// ---------------------------------------------------------------------------
export class HudOverlay {
  render(g, w, h, state, info) {
    const t = state?.telemetry || {};
    const link = state?.link || {};
    g.save();
    g.strokeStyle = HUD; g.fillStyle = HUD; g.lineWidth = 1.4;
    g.shadowColor = "rgba(0,0,0,.85)"; g.shadowBlur = 3;
    g.font = "600 12px Consolas, Menlo, monospace"; g.textBaseline = "middle";
    const cx = w / 2, cy = h / 2;
    // 조준선
    g.beginPath();
    g.moveTo(cx - 26, cy); g.lineTo(cx - 8, cy); g.moveTo(cx + 8, cy); g.lineTo(cx + 26, cy);
    g.moveTo(cx, cy - 26); g.lineTo(cx, cy - 8); g.moveTo(cx, cy + 8); g.lineTo(cx, cy + 26);
    g.stroke();
    g.strokeRect(cx - 60, cy - 40, 120, 80);
    // 피치 사다리 (롤 회전)
    const ppd = h / 60;
    g.save(); g.translate(cx, cy); g.rotate(rad(-(t.roll || 0)));
    g.globalAlpha = 0.75;
    for (const p of [-20, -10, 0, 10, 20]) {
      const y = (p + (t.pitch || 0)) * ppd;
      if (Math.abs(y) > h * 0.42) continue;
      const half = p === 0 ? 120 : 55;
      g.setLineDash(p < 0 ? [6, 5] : []);
      g.beginPath(); g.moveTo(-half, y); g.lineTo(-22, y); g.moveTo(22, y); g.lineTo(half, y); g.stroke();
      if (p) { g.textAlign = "left"; g.fillText(String(p), half + 5, y); }
    }
    g.setLineDash([]); g.restore();
    // 기수 테이프
    const hd = t.heading || 0, tw = Math.min(w * 0.5, 380), x0 = cx - tw / 2, y0 = 58;
    g.beginPath(); g.moveTo(x0, y0 + 12); g.lineTo(x0 + tw, y0 + 12); g.stroke();
    g.textAlign = "center";
    for (let d = Math.ceil((hd - 35) / 5) * 5; d <= hd + 35; d += 5) {
      const x = cx + ((d - hd) / 35) * (tw / 2);
      const major = d % 10 === 0;
      g.beginPath(); g.moveTo(x, y0 + 12); g.lineTo(x, y0 + (major ? 4 : 8)); g.stroke();
      if (d % 30 === 0) g.fillText(cardinal(((d % 360) + 360) % 360), x, y0 - 4);
    }
    box(g, cx - 26, y0 + 15, 52, 18, String(Math.round(hd) % 360).padStart(3, "0"));
    // 속도(좌) / 고도(우)
    tape(g, 34, cy, t.groundspeed ?? 0, "GS m/s", 2, "left", h);
    tape(g, w - 34, cy, t.alt_rel ?? 0, "ALT m", 10, "right", h);
    // 상단 좌/우 정보
    g.textAlign = "left";
    g.fillText(`${info.mode}  ${t.mode || "—"}${t.armed ? "  ARMED" : ""}`, 12, 14);
    if (Math.floor(Date.now() / 600) % 2) { g.fillStyle = "#ff5a52"; g.beginPath(); g.arc(16, 32, 4, 0, Math.PI * 2); g.fill(); g.fillStyle = HUD; }
    g.fillText(`REC ${new Date().toISOString().slice(11, 19)}Z`, 26, 32);
    g.textAlign = "right";
    const lk = link.connected ? `LINK ${link.rssi_dbm ?? "—"}dBm ${Math.round(link.latency_ms ?? 0)}ms` : "LINK LOST";
    g.fillStyle = link.connected ? HUD : "#ff6d66";
    g.fillText(lk, w - 12, 14);
    g.fillStyle = HUD;
    g.fillText(`VS ${(t.vspeed ?? 0).toFixed(1)}  BAT ${(t.battery_pct ?? 0).toFixed(0)}%`, w - 12, 32);
    // 하단: 짐벌/표적 좌표
    g.textAlign = "left";
    g.fillText(`GMB P${(t.gimbal?.pitch ?? 0).toFixed(0)}° Y${(t.gimbal?.yaw ?? 0).toFixed(0)}°  R${(t.roll ?? 0).toFixed(0)}° P${(t.pitch ?? 0).toFixed(0)}°`, 12, h - 30);
    if (info.geo) {
      g.fillText(`TGT ${info.geo.lat.toFixed(5)}N ${info.geo.lon.toFixed(5)}E  SLR ${fmtDist(info.geo.slant)}`, 12, h - 12);
    }
    g.textAlign = "right";
    g.fillText(`${info.source}`, w - 12, h - 12);
    if (!link.connected) {
      g.fillStyle = "rgba(60,0,0,.55)"; g.fillRect(cx - 150, cy + 50, 300, 34);
      g.fillStyle = "#ffb3b0"; g.textAlign = "center"; g.font = "700 15px Segoe UI, Malgun Gothic, sans-serif";
      g.fillText("데이터링크 단절 — 마지막 영상 정지", cx, cy + 67);
    }
    g.restore();
  }
}

function cardinal(d) { return { 0: "N", 90: "E", 180: "S", 270: "W" }[d] ?? String(d / 10).padStart(2, "0"); }
function box(g, x, y, w, h, text) {
  g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h);
  g.fillStyle = HUD; g.textAlign = "center"; g.fillText(text, x + w / 2, y + h / 2 + 1);
}
function tape(g, x, cy, v, label, step, side, h) {
  const span = h * 0.5, unit = span / (step * 6);
  const dir = side === "left" ? 1 : -1;
  g.beginPath(); g.moveTo(x, cy - span / 2); g.lineTo(x, cy + span / 2); g.stroke();
  g.textAlign = side === "left" ? "left" : "right";
  for (let k = Math.ceil((v - step * 3) / step) * step; k <= v + step * 3; k += step) {
    const y = cy - (k - v) * unit;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + dir * 7, y); g.stroke();
    g.fillText(String(Math.round(k)), x + dir * 10, y);
  }
  const bw = 58, bx = side === "left" ? x + 8 : x - 8 - bw;
  box(g, bx, cy - 10, bw, 20, v.toFixed(1));
  g.textAlign = side === "left" ? "left" : "right";
  g.fillText(label, x, cy - span / 2 - 10);
}

// ---------------------------------------------------------------------------
export class VideoPanel {
  constructor(canvas, sources) {
    this.c = canvas; this.ctx = canvas.getContext("2d");
    this.sources = sources; this.source = sources[0];
    this.mode = "EO"; this.state = null; this.hud = new HudOverlay();
    this.source.start();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();
    let last = 0;
    const loop = (t) => {
      if (t - last > 50) { last = t; this.draw(t); }   // 약 20 fps
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  _resize() {
    const r = this.c.getBoundingClientRect();
    this.w = Math.max(10, Math.round(r.width)); this.h = Math.max(10, Math.round(r.height));
    this.c.width = this.w; this.c.height = this.h;
  }
  setSource(id) {
    const s = this.sources.find((x) => x.id === id); if (!s || s === this.source) return;
    this.source.stop(); this.source = s; s.start();
  }
  setMode(m) { this.mode = m; }
  update(state) { this.state = state; }
  draw(t) {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const geo = this.source.render(g, this.w, this.h, { state: this.state, mode: this.mode, t });
    this.hud.render(g, this.w, this.h, this.state, { mode: this.mode, geo, source: `SRC:${this.source.id.toUpperCase()}` });
  }
}
