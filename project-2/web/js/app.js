// UGCS 조종 콘솔 — 진입점: 로그인, 실시간 상태(SSE), 상태바, 경보, 제어권, 비행 명령
import { api, openStream } from "./api.js";
import { TacticalMap } from "./map.js";
import { VideoPanel, SimulatedEoIrSource, MjpegSource, WebRtcSource } from "./video.js";
import { LocalProjection, fmtDist, fmtBrg, fmtDur } from "./geo.js";
import { initOps } from "./ops.js";

const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleTimeString("ko-KR", { hour12: false }) : "—");
export const fmtDateTime = (t) => (t ? new Date(t * 1000).toLocaleString("ko-KR", { hour12: false }) : "—");

const STATUS_BADGE = { AIRWORTHY: "ok", MAINTENANCE_REQUIRED: "warn", GROUNDED: "crit" };
const STATUS_LABEL = { AIRWORTHY: "비행 가능", MAINTENANCE_REQUIRED: "정비 필요", GROUNDED: "비행 불가" };
const SEV_BADGE = { CRITICAL: "crit", WARNING: "warn", INFO: "info" };
const CMD_LABEL = { TAKEOFF: "이륙", UPLOAD_MISSION: "임무 업로드", START_MISSION: "임무 시작", PAUSE: "일시정지",
  RESUME: "재개", RTL: "복귀(RTL)", LAND: "착륙", ESTOP: "비상정지", GIMBAL: "짐벌" };
const DANGER = {
  RTL: { title: "강제 복귀(RTL)", text: "현재 임무를 중단하고 이착륙 지점으로 즉시 복귀합니다." },
  LAND: { title: "현 위치 착륙", text: "현재 위치에서 수직 착륙합니다. 지상 장애물을 확인하세요." },
  ESTOP: { title: "비상정지", text: "모터를 즉시 정지합니다. 기체는 추락하며 파손될 수 있습니다. 인명·충돌 위험 시에만 사용하세요.", type: "비상정지" },
};

const S = { me: null, perms: new Set(), state: null, alertView: "active", seenAlerts: new Set(), muted: false, audio: null };
let map, video, stream;
const listeners = new Set();

// ---- 공용 UI -------------------------------------------------------------
export function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg; t.className = `toast on ${kind}`;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.className = "toast"), kind === "err" ? 4800 : 2800);
}

export function modal({ title, html = "", danger = false, ok = "확인", typeText = null }) {
  return new Promise((resolve) => {
    const m = $("#modal"), card = $("#modal-card");
    card.className = `modal-card${danger ? " danger" : ""}`;
    card.innerHTML = `<h3 id="modal-title">${esc(title)}</h3><div>${html}</div>
      ${typeText ? `<label for="modal-type">확인을 위해 <b>${esc(typeText)}</b> 를 입력하세요</label><input id="modal-type" autocomplete="off">` : ""}
      <div class="acts"><button class="btn" type="button" data-r="0">취소</button>
      <button class="btn ${danger ? "danger" : "primary"}" type="button" data-r="1" ${typeText ? "disabled" : ""}>${esc(ok)}</button></div>`;
    m.hidden = false;
    const okBtn = card.querySelector('[data-r="1"]');
    const typed = card.querySelector("#modal-type");
    if (typed) { typed.addEventListener("input", () => (okBtn.disabled = typed.value.trim() !== typeText)); typed.focus(); }
    else card.querySelector('[data-r="0"]').focus();
    const done = (v) => { m.hidden = true; card.innerHTML = ""; document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    card.onclick = (e) => { const b = e.target.closest("[data-r]"); if (b && !b.disabled) done(b.dataset.r === "1"); };
  });
}

export const can = (perm) => S.perms.has(perm);
export const holdsControl = () => !!S.me && S.state?.control?.holder_id === S.me.id;

export async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, "ok"); return r; }
  catch (e) { toast(`${e.status ? `[${e.status}] ` : ""}${e.message}`, "err"); return null; }
}

// ---- 로그인 --------------------------------------------------------------
async function boot() {
  try { const me = await api("GET", "/api/auth/me"); return start(me); }
  catch { /* 미로그인 */ }
  const users = await api("GET", "/api/users");
  $("#login-user").innerHTML = users.map((u) => `<option value="${esc(u.username)}">${esc(u.display_name)} · ${esc(u.role)}</option>`).join("");
  $("#login").hidden = false;
  $("#login-pin").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#login-msg");
  try {
    const r = await api("POST", "/api/auth/login", { username: $("#login-user").value, pin: $("#login-pin").value });
    msg.className = "hint"; start(r.user);
  } catch (err) { msg.textContent = err.message; msg.className = "hint err"; $("#login-pin").select(); }
});

async function start(me) {
  S.me = me; S.perms = new Set(me.permissions);
  $("#login").hidden = true; $("#app").hidden = false;
  $("#me-name").textContent = me.display_name;
  $("#me-role").textContent = me.role_label; $("#me-role").className = "badge info";
  try { S.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { S.audio = null; }

  const [st, zones] = await Promise.all([api("GET", "/api/state"), api("GET", "/api/zones")]);
  const ref = st.gcs || { lat: 36.14, lon: 128.39 };
  map = new TacticalMap($("#map"), $("#map-read"));
  map.setReference(ref.lat, ref.lon);
  map.setZones(zones.zones, zones.comm_radius_m);
  map.mpp = 3.5;
  map.onFollowChange = (on) => { $("#m-follow").classList.toggle("on", on); $("#m-follow").setAttribute("aria-pressed", on); };
  const proj = new LocalProjection(ref.lat, ref.lon);
  const sim = new SimulatedEoIrSource(proj);
  sim.setZones(zones.zones, proj);
  video = new VideoPanel($("#video"), [sim, new MjpegSource(), new WebRtcSource()]);
  $("#v-source").innerHTML = video.sources.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("");

  const ctx = { S, api, toast, modal, can, holdsControl, run, esc, map, zones, fmtTime, fmtDateTime,
    on: (fn) => listeners.add(fn), STATUS_BADGE, STATUS_LABEL, SEV_BADGE, refreshAircraft };
  window.__ugcs = ctx;   // 디버깅용
  initOps(ctx);
  await refreshAircraft();
  onState(st);
  stream = openStream({
    state: onState,
    alert: () => { if (S.alertView === "history") loadAlertHistory(); },
    control: () => {},
    flight: (f) => { if (f.started) { map.clearTrail(); toast(`비행 기록 #${f.started} 시작`); } if (f.ended) toast(`비행 기록 #${f.ended} 저장 완료`, "ok"); listeners.forEach((fn) => fn("flight", f)); },
  }, (ok) => { if (!ok) $("#p-link").classList.add("warn"); });
}

$("#logout-btn").addEventListener("click", async () => { await run(() => api("POST", "/api/auth/logout")); location.reload(); });
$("#mute-btn").addEventListener("click", () => { S.muted = !S.muted; $("#mute-btn").textContent = S.muted ? "경보음 꺼짐" : "경보음 켜짐"; });

// ---- 기체 선택 -----------------------------------------------------------
async function refreshAircraft() {
  const r = await api("GET", "/api/aircraft");
  $("#ac-select").innerHTML = r.aircraft.map((a) => `<option value="${esc(a.id)}" ${a.id === r.active ? "selected" : ""}>${esc(a.id)} ${esc(a.name)} — ${STATUS_LABEL[a.status]}</option>`).join("");
  return r;
}
$("#ac-select").addEventListener("change", async (e) => {
  const r = await run(() => api("POST", `/api/aircraft/${e.target.value}/select`), `연결 기체: ${e.target.value}`);
  if (!r) await refreshAircraft();
  listeners.forEach((fn) => fn("aircraft"));
});

// ---- 실시간 상태 ---------------------------------------------------------
function onState(st) {
  S.state = st;
  map?.update(st);
  video?.update(st);
  renderTop(st);
  renderStatus(st);
  if (S.alertView === "active") renderAlerts(st.alerts_active, true);
  $("#alert-count").textContent = st.alerts_active.length;
  renderCmds();
  beepOnNew(st.alerts_active);
  listeners.forEach((fn) => fn("state", st));
}

function pill(id, text, cls) { const p = $(id); p.querySelector("b").textContent = text; p.className = `pill ${cls || ""}`; }

function renderTop(st) {
  const t = st.telemetry || {}, l = st.link || {}, ac = st.aircraft;
  pill("#p-mode", t.mode || "—", t.mode === "ESTOP" ? "crit" : ["RTL", "LAND"].includes(t.mode) ? "warn" : t.armed ? "ok" : "");
  pill("#p-link", l.connected ? "OK" : "LOST", l.connected ? (l.latency_ms > 400 || l.loss_pct > 15 ? "warn" : "ok") : "crit");
  const b = t.battery_pct;
  pill("#p-batt", b == null ? "—" : `${b.toFixed(0)}%`, b == null ? "" : b <= 15 ? "crit" : b <= 30 ? "warn" : "ok");
  const gps = t.gps || {};
  pill("#p-gps", `${gps.fix ?? 0}D·${gps.sats ?? 0}`, (gps.fix ?? 0) < 3 || (gps.sats ?? 0) < 6 ? "warn" : "ok");
  pill("#p-flt", st.flight ? fmtDur(st.flight.elapsed_s) : "지상", st.flight ? "ok" : "");
  if (ac) { const s = $("#ac-status"); s.textContent = STATUS_LABEL[ac.status]; s.className = `badge ${STATUS_BADGE[ac.status]}`; }
  if (ac && $("#ac-select").value !== ac.id) $("#ac-select").value = ac.id;

  const c = st.control || {}, mine = holdsControl();
  $("#ctl-holder").textContent = c.holder_name ? `${c.holder_name}` : "없음";
  $("#ctl").className = `ctl ${mine ? "mine" : c.holder_id ? "other" : ""}`;
  const btn = $("#ctl-btn");
  if (mine) { btn.textContent = "제어권 이양"; btn.disabled = false; btn.dataset.act = "release"; }
  else if (c.holder_id) {
    btn.textContent = "강제 인수"; btn.dataset.act = "force";
    btn.disabled = !can("control.force"); btn.title = can("control.force") ? "" : "임무통제관만 강제 인수할 수 있습니다";
  } else { btn.textContent = "제어권 인수"; btn.dataset.act = "acquire"; btn.disabled = !can("control.acquire"); btn.title = btn.disabled ? "이 역할은 제어권을 가질 수 없습니다" : ""; }
}

function stat(id, val, unit, cls, barPct) {
  const el = $(id);
  el.className = `stat ${cls || ""}`;
  el.querySelector("b").textContent = val;
  el.querySelector("em").textContent = unit;
  const bar = el.querySelector(".bar span");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, barPct ?? 0))}%`;
}

function renderStatus(st) {
  const t = st.telemetry || {}, l = st.link || {};
  const rssi = l.rssi_dbm;
  stat("#s-rssi", l.connected && rssi != null ? rssi.toFixed(0) : "—", "dBm", !l.connected ? "crit" : rssi < -80 ? "warn" : "ok", rssi == null ? 0 : ((rssi + 100) / 62) * 100);
  stat("#s-lat", l.connected ? (l.latency_ms ?? 0).toFixed(0) : "—", "ms", !l.connected ? "crit" : l.latency_ms >= 1200 ? "crit" : l.latency_ms >= 400 ? "warn" : "ok");
  stat("#s-loss", (l.loss_pct ?? 0).toFixed(1), "%", l.loss_pct >= 15 ? "warn" : "ok");
  const b = t.battery_pct;
  stat("#s-batt", b == null ? "—" : b.toFixed(1), `% ${t.battery_v ? t.battery_v.toFixed(1) + "V" : ""}`, b == null ? "" : b <= 15 ? "crit" : b <= 30 ? "warn" : "ok", b);
  const g = t.gps || {};
  stat("#s-gps", String(g.sats ?? 0), `${g.fix ?? 0}D HDOP ${g.hdop ?? "—"}`, (g.fix ?? 0) < 3 || (g.sats ?? 0) < 6 ? "warn" : "ok");
  const r = st.relative;
  stat("#s-range", r ? fmtDist(r.distance_m) : "—", r ? fmtBrg(r.bearing_deg) : "", r && !r.in_range ? "crit" : r && r.range_ratio > 0.9 ? "warn" : "");
}

function alertItem(a) {
  const canAck = can("alert.ack") && !a.acked_at;
  return `<li class="alert ${a.severity} ${a.acked_at ? "" : "unacked"} ${a.cleared_at ? "cleared" : ""}">
    <span class="badge ${SEV_BADGE[a.severity]}">${a.severity}</span>
    <span class="msg">${esc(a.message)}</span>
    ${canAck ? `<button class="btn sm" type="button" data-ack="${a.id}">인지</button>` : `<span class="badge">${a.acked_at ? "인지됨" : "미인지"}</span>`}
    <span class="cause">${esc(a.cause)}</span>
    <span class="meta">${esc(a.code)} · 발생 ${fmtTime(a.raised_at)}${a.acked_at ? ` · 인지 ${fmtTime(a.acked_at)} ${esc(a.acked_by_name || "")}` : ""}${a.cleared_at ? ` · 해제 ${fmtTime(a.cleared_at)}` : ""}</span>
  </li>`;
}
function renderAlerts(list, active) {
  const ol = $("#alerts");
  if (!list.length) { ol.innerHTML = `<li class="empty">${active ? "활성 경보 없음" : "경보 이력 없음"}</li>`; return; }
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  const sorted = active ? [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || b.raised_at - a.raised_at) : list;
  const html = sorted.map(alertItem).join("");
  if (ol._html !== html) { ol.innerHTML = html; ol._html = html; }
}
async function loadAlertHistory() { const l = await run(() => api("GET", "/api/alerts?limit=150")); if (l) renderAlerts(l, false); }

$("#alerts").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ack]"); if (!b) return;
  b.disabled = true;
  await run(() => api("POST", `/api/alerts/${b.dataset.ack}/ack`), "경보 인지 처리");
  if (S.alertView === "history") loadAlertHistory();
});
document.querySelectorAll("[data-alerts]").forEach((b) => b.addEventListener("click", () => {
  S.alertView = b.dataset.alerts;
  document.querySelectorAll("[data-alerts]").forEach((x) => x.classList.toggle("on", x === b));
  $("#alerts")._html = null;
  if (S.alertView === "history") loadAlertHistory(); else renderAlerts(S.state?.alerts_active || [], true);
}));

function beepOnNew(active) {
  let crit = false;
  for (const a of active) {
    if (!S.seenAlerts.has(a.id)) { S.seenAlerts.add(a.id); if (a.severity === "CRITICAL" && !a.acked_at) crit = true; }
  }
  if (crit && !S.muted && S.audio) {
    const o = S.audio.createOscillator(), g = S.audio.createGain();
    o.type = "square"; o.frequency.value = 880; g.gain.value = 0.05;
    o.connect(g).connect(S.audio.destination);
    o.start(); o.frequency.setValueAtTime(660, S.audio.currentTime + 0.18); o.stop(S.audio.currentTime + 0.4);
  }
}

// ---- 제어권 / 명령 -------------------------------------------------------
$("#ctl-btn").addEventListener("click", async (e) => {
  const act = e.currentTarget.dataset.act;
  if (act === "release") return run(() => api("POST", "/api/control/release"), "제어권을 이양(해제)했습니다");
  if (act === "force") {
    const ok = await modal({ title: "제어권 강제 인수", danger: true, ok: "강제 인수",
      html: `<p>현재 보유자 <b>${esc(S.state?.control?.holder_name)}</b>의 제어권을 인수합니다. 감사 로그에 기록됩니다.</p>` });
    if (!ok) return;
    return run(() => api("POST", "/api/control/acquire", { force: true }), "제어권을 강제 인수했습니다");
  }
  return run(() => api("POST", "/api/control/acquire", {}), "제어권을 인수했습니다");
});

function renderCmds() {
  const mine = holdsControl();
  document.querySelectorAll("[data-cmd]").forEach((b) => {
    const okPerm = can(`cmd.${b.dataset.cmd}`);
    b.disabled = !(mine && okPerm);
    b.title = !okPerm ? "이 역할에는 권한이 없습니다" : !mine ? "제어권 보유자만 실행할 수 있습니다" : "";
  });
  const note = $("#cmd-note");
  if (!can("cmd.TAKEOFF")) { note.textContent = `${S.me.role_label} 역할은 비행 명령 권한이 없습니다 (서버에서 403 차단)`; note.className = "note"; }
  else if (!mine) { note.textContent = "제어권을 인수해야 명령할 수 있습니다 (미보유 시 서버에서 403 차단)"; note.className = "note"; }
  else { note.textContent = `제어권 보유 중 · 연결 기체 ${S.state?.aircraft?.id || ""}`; note.className = "note ok"; }
}

export async function sendCommand(cmd, params = {}) {
  const d = DANGER[cmd];
  if (d) {
    const ok = await modal({ title: d.title, danger: true, ok: `${CMD_LABEL[cmd]} 실행`, typeText: d.type || null,
      html: `<p>${esc(d.text)}</p><p class="muted">기체: ${esc(S.state?.aircraft?.id)} · 고도 ${(S.state?.telemetry?.alt_rel ?? 0).toFixed(0)} m</p>` });
    if (!ok) return null;
    params = { ...params, confirm: cmd };
  }
  return run(() => api("POST", `/api/commands/${cmd}`, params), `${CMD_LABEL[cmd]} 명령 승인 (ACK)`);
}

document.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", async () => {
  const cmd = b.dataset.cmd;
  if (cmd === "TAKEOFF") return sendCommand(cmd, { alt: Number($("#to-alt").value) });
  if (cmd === "UPLOAD_MISSION") {
    const mid = window.__ugcs?.selectedMissionId;
    if (!mid) return toast("임무 계획 탭에서 업로드할 임무를 선택하세요", "err");
    const r = await sendCommand(cmd, { mission_id: mid });
    if (r) listeners.forEach((fn) => fn("missions"));
    return r;
  }
  return sendCommand(cmd);
}));

// ---- 지도/영상 도구 ------------------------------------------------------
$("#m-follow").addEventListener("click", () => map.setFollow(!map.follow));
$("#m-fit").addEventListener("click", () => map.fit());
$("#m-clear-trail").addEventListener("click", () => map.clearTrail());
$("#m-edit").addEventListener("click", () => listeners.forEach((fn) => fn("toggle-edit")));
document.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => {
  video.setMode(b.dataset.cam);
  document.querySelectorAll("[data-cam]").forEach((x) => x.classList.toggle("on", x === b));
}));
$("#v-source").addEventListener("change", (e) => video.setSource(e.target.value));
for (const id of ["g-pitch", "g-yaw"]) {
  const el = $(`#${id}`);
  el.addEventListener("input", () => ($(`#${id}-v`).textContent = `${el.value}°`));
  el.addEventListener("change", () => {
    if (!holdsControl()) return toast("짐벌 제어는 제어권 보유자만 가능합니다", "err");
    run(() => api("POST", "/api/commands/GIMBAL", { pitch: Number($("#g-pitch").value), yaw: Number($("#g-yaw").value) }));
  });
}
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); });
  document.querySelectorAll(".tab-body").forEach((p) => (p.hidden = p.id !== `tab-${b.dataset.tab}`));
  listeners.forEach((fn) => fn("tab", b.dataset.tab));
}));

boot().catch((e) => { $("#login").hidden = false; $("#login-msg").textContent = `서버 연결 실패: ${e.message}`; $("#login-msg").className = "hint err"; });
