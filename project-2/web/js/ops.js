// 운용 탭: 임무 계획 · 비행 기록/재생 · 정비 이력 · 시뮬레이터 · 감사 로그
import { fmtDist, fmtBrg, fmtDur } from "./geo.js";

const $ = (s, r = document) => r.querySelector(s);
const ACTIONS = ["WAYPOINT", "LOITER", "PHOTO", "SURVEY", "LAND"];
const MSTATUS = { DRAFT: "", READY: "ok", UPLOADED: "info", ARCHIVED: "violet" };
const CHECK_ITEMS = ["기체 외관·프레임 균열", "프로펠러 손상/체결", "모터 진동·발열", "배터리 셀 전압 균형",
  "GNSS·나침반 보정", "데이터링크 안테나·커넥터", "짐벌·EO/IR 카메라", "비상 낙하산/페일세이프 설정"];

export function initOps(ctx) {
  const P = planner(ctx);
  const F = flights(ctx);
  const M = maintenance(ctx);
  const SIM = simulator(ctx);
  const A = audit(ctx);
  ctx.on((ev, data) => {
    if (ev === "toggle-edit") P.toggleEdit();
    if (ev === "missions" || ev === "aircraft") P.load();
    if (ev === "flight") { F.load(); }
    if (ev === "state") SIM.sync(data);
    if (ev === "tab") { if (data === "audit") A.load(); if (data === "flights") F.load(); if (data === "maint") M.load(); }
  });
}

// =========================================================================
// 임무 계획
// =========================================================================
function planner(ctx) {
  const { api, run, esc, map, can, toast, modal } = ctx;
  const root = $("#tab-planner");
  let missions = [], aircraft = [], cur = null, dirty = false, edit = false, plan = null, timer = null;

  root.innerHTML = `<div class="split">
    <div><div class="btns"><button class="btn sm primary" id="pl-new" type="button">새 임무</button>
      <label class="muted" style="display:flex;gap:5px;align-items:center;font-size:12px"><input type="checkbox" id="pl-arch"> 보관 포함</label></div>
      <div class="list" id="pl-list"></div></div>
    <div id="pl-ed"><div class="empty">왼쪽에서 임무를 선택하거나 새 임무를 만드세요.</div></div></div>`;

  const editable = () => cur && can("mission.write") && cur.status !== "ARCHIVED";

  async function load() {
    const [ms, ac] = await Promise.all([api("GET", "/api/missions"), api("GET", "/api/aircraft")]);
    missions = ms; aircraft = ac.aircraft;
    if (cur?.id) { const f = missions.find((m) => m.id === cur.id); if (f && !dirty) select(f, true); }
    renderList();
  }
  function renderList() {
    const showArch = $("#pl-arch").checked;
    const list = missions.filter((m) => showArch || m.status !== "ARCHIVED");
    $("#pl-list").innerHTML = list.map((m) => `<button type="button" class="item ${cur?.id === m.id ? "sel" : ""}" data-mid="${m.id}">
      <span class="row"><b>${esc(m.name)}</b><span class="badge ${MSTATUS[m.status]}">${m.status}</span></span>
      <small>#${m.id} · ${esc(m.aircraft_id)} · v${m.version} · WP ${m.waypoints.length}${ctx.S.state?.active_mission_id === m.id ? " · 기체 탑재" : ""}</small></button>`).join("")
      || `<div class="empty">임무 없음</div>`;
  }
  $("#pl-arch").addEventListener("change", renderList);
  $("#pl-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-mid]"); if (!b) return;
    if (dirty && !(await modal({ title: "저장하지 않은 변경", html: "<p>편집 중인 내용을 버리고 다른 임무를 열까요?</p>", ok: "버리고 열기" }))) return;
    select(missions.find((m) => m.id === Number(b.dataset.mid)));
  });
  $("#pl-new").addEventListener("click", async () => {
    if (!can("mission.write")) return toast("임무 작성 권한이 없습니다", "err");
    const m = await run(() => api("POST", "/api/missions", { name: `신규 임무 ${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`,
      aircraft_id: ctx.S.state?.aircraft?.id || "UAV-01", waypoints: [] }), "새 임무를 만들었습니다 — 지도에서 경로를 찍으세요");
    if (m) { await load(); select(m); setEdit(true); }
  });

  function select(m, keepPlan) {
    cur = structuredClone(m); dirty = false;
    ctx.selectedMissionId = m.id;
    window.__ugcs.selectedMissionId = m.id;
    if (!keepPlan) plan = m.last_plan;
    renderEditor(); renderList(); syncMap();
    if (!keepPlan) compute();
  }
  function syncMap() { map.setMission(cur?.waypoints || [], cur?.home, editable() && edit); }
  function setEdit(on) {
    edit = !!on && editable();
    map.setEdit(edit);
    $("#m-edit").classList.toggle("on", edit); $("#m-edit").setAttribute("aria-pressed", edit);
    $("#map-hint").hidden = !edit;
    if (edit) map.setFollow(false);
    syncMap();
  }
  function toggleEdit() {
    if (!cur) return toast("먼저 임무 계획 탭에서 임무를 선택하세요", "err");
    if (!editable()) return toast(cur.status === "ARCHIVED" ? "보관된 임무는 편집할 수 없습니다" : "임무 작성 권한이 없습니다", "err");
    setEdit(!edit);
  }
  map.onWpChange = (wps, info) => {
    if (!cur) return;
    cur.waypoints = wps.map((w) => ({ ...w }));
    markDirty(); renderWps(); if (!info.live) compute(); else schedule();
  };

  function markDirty() { dirty = true; const s = $("#pl-dirty"); if (s) s.hidden = false; }
  function schedule() { clearTimeout(timer); timer = setTimeout(compute, 350); }
  async function compute() {
    if (!cur) return;
    try {
      plan = await api("POST", "/api/route/compute", { home: cur.home, waypoints: cur.waypoints, geofence: cur.geofence,
        start_battery_pct: cur.aircraft_id === ctx.S.state?.aircraft?.id && ctx.S.state?.telemetry?.battery_pct != null && !ctx.S.state.telemetry.armed
          ? ctx.S.state.telemetry.battery_pct : 100 });
    } catch (e) { plan = { ok: false, issues: [{ severity: "ERROR", message: e.message }], legs: [] }; }
    renderPlan();
  }

  function renderEditor() {
    const ed = $("#pl-ed");
    if (!cur) { ed.innerHTML = `<div class="empty">임무를 선택하세요.</div>`; return; }
    const ro = !editable();
    ed.innerHTML = `
      <div class="form-row">
        <div class="fld" style="flex:1;min-width:200px"><label for="pl-name">임무명</label><input id="pl-name" value="${esc(cur.name)}" ${ro ? "disabled" : ""}></div>
        <div class="fld"><label for="pl-ac">대상 기체</label><select id="pl-ac" ${ro ? "disabled" : ""}>${aircraft.map((a) =>
          `<option value="${esc(a.id)}" ${a.id === cur.aircraft_id ? "selected" : ""}>${esc(a.id)} ${esc(a.name)} (${ctx.STATUS_LABEL[a.status]})</option>`).join("")}</select></div>
        <div class="fld"><label>상태 / 버전</label><span><span class="badge ${MSTATUS[cur.status]}">${cur.status}</span> <span class="badge">v${cur.version}</span>
          <span class="badge warn" id="pl-dirty" hidden>저장 안 됨</span></span></div>
      </div>
      <div class="btns">
        <button class="btn sm" type="button" id="pl-edit" ${ro ? "disabled" : ""}>${edit ? "지도 편집 끄기" : "지도에서 편집"}</button>
        <button class="btn sm" type="button" id="pl-add" ${ro ? "disabled" : ""}>WP 추가</button>
        <button class="btn sm primary" type="button" id="pl-save" ${ro ? "disabled" : ""}>저장</button>
        <button class="btn sm" type="button" id="pl-validate">검증 (서버 저장)</button>
        <button class="btn sm" type="button" data-st="READY" ${can("mission.approve") && ["DRAFT"].includes(cur.status) ? "" : "disabled"} title="임무통제관 승인">READY 승인</button>
        <button class="btn sm" type="button" data-st="DRAFT" ${can("mission.write") && ["READY", "UPLOADED", "ARCHIVED"].includes(cur.status) ? "" : "disabled"}>DRAFT로</button>
        <button class="btn sm" type="button" data-st="ARCHIVED" ${can("mission.archive") && cur.status !== "ARCHIVED" ? "" : "disabled"}>보관</button>
        <button class="btn sm danger" type="button" id="pl-del" ${can("mission.write") && cur.status !== "UPLOADED" ? "" : "disabled"}>삭제</button>
        <span class="muted" style="font-size:12px;align-self:center">업로드는 ‘비행 제어 → 임무 업로드’ (READY 상태 + 제어권 필요)</span>
      </div>
      <div class="tbl-wrap"><table><thead><tr><th>#</th><th>위도</th><th>경도</th><th class="num">고도 m</th><th class="num">속도 m/s</th><th class="num">체공 s</th><th>임무동작</th><th></th></tr></thead>
        <tbody id="pl-wps"></tbody></table></div>
      <div id="pl-plan"></div>`;
    renderWps(); renderPlan();
    $("#pl-name")?.addEventListener("input", (e) => { cur.name = e.target.value; markDirty(); });
    $("#pl-ac")?.addEventListener("change", (e) => { cur.aircraft_id = e.target.value; markDirty(); });
    $("#pl-edit").addEventListener("click", () => { toggleEdit(); renderEditor(); });
    $("#pl-add").addEventListener("click", () => {
      const last = cur.waypoints[cur.waypoints.length - 1] || { lat: cur.home.lat + 0.002, lon: cur.home.lon, alt: 60, speed: 10 };
      cur.waypoints.push({ lat: +(last.lat + 0.0015).toFixed(6), lon: +(last.lon + 0.0015).toFixed(6), alt: last.alt, speed: last.speed, hold: 0, action: "WAYPOINT" });
      markDirty(); renderWps(); syncMap(); compute();
    });
    $("#pl-save").addEventListener("click", save);
    $("#pl-validate").addEventListener("click", async () => {
      if (dirty && !(await save())) return;
      const p = await run(() => api("POST", `/api/missions/${cur.id}/validate`), "검증 결과를 저장했습니다");
      if (p) { plan = p; renderPlan(); }
    });
    ed.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", async () => {
      if (dirty && !(await save())) return;
      const m = await run(() => api("POST", `/api/missions/${cur.id}/status`, { status: b.dataset.st }), `상태 변경: ${b.dataset.st}`);
      if (m) { await load(); select(m); }
    }));
    $("#pl-del").addEventListener("click", async () => {
      if (!(await modal({ title: "임무 삭제", danger: true, ok: "삭제", html: `<p>‘${esc(cur.name)}’ 임무를 삭제합니다. 비행 기록이 있으면 삭제되지 않습니다.</p>` }))) return;
      if (await run(() => api("DELETE", `/api/missions/${cur.id}`), "삭제했습니다")) { cur = null; ctx.selectedMissionId = null; setEdit(false); renderEditor(); syncMap(); load(); }
    });
  }

  async function save() {
    const m = await run(() => api("PUT", `/api/missions/${cur.id}`, { name: cur.name, aircraft_id: cur.aircraft_id, waypoints: cur.waypoints }),
      "저장했습니다 (버전 증가 · DRAFT로 전환)");
    if (!m) return false;
    dirty = false; await load(); select(m);
    return true;
  }

  function renderWps() {
    const tb = $("#pl-wps"); if (!tb) return;
    const ro = !editable();
    tb.innerHTML = cur.waypoints.map((w, i) => `<tr data-i="${i}" class="${map.selWp === i ? "sel" : ""}">
      <td class="num">${i + 1}</td>
      <td><input data-k="lat" value="${w.lat}" ${ro ? "disabled" : ""} aria-label="WP${i + 1} 위도"></td>
      <td><input data-k="lon" value="${w.lon}" ${ro ? "disabled" : ""} aria-label="WP${i + 1} 경도"></td>
      <td><input data-k="alt" type="number" value="${w.alt}" ${ro ? "disabled" : ""} aria-label="WP${i + 1} 고도"></td>
      <td><input data-k="speed" type="number" step="0.5" value="${w.speed}" ${ro ? "disabled" : ""} aria-label="WP${i + 1} 속도"></td>
      <td><input data-k="hold" type="number" value="${w.hold}" ${ro ? "disabled" : ""} aria-label="WP${i + 1} 체공시간"></td>
      <td><select data-k="action" ${ro ? "disabled" : ""} aria-label="WP${i + 1} 임무동작">${ACTIONS.map((a) => `<option ${a === w.action ? "selected" : ""}>${a}</option>`).join("")}</select></td>
      <td>${ro ? "" : `<button class="btn sm ghost" type="button" data-up="${i}" title="위로">↑</button><button class="btn sm ghost" type="button" data-rm="${i}" title="삭제">✕</button>`}</td></tr>`).join("")
      || `<tr><td colspan="8" class="empty">웨이포인트 없음 — ‘지도에서 편집’ 후 지도를 클릭하세요</td></tr>`;
  }
  root.addEventListener("change", (e) => {
    const k = e.target.dataset?.k; if (!k || !cur) return;
    const i = Number(e.target.closest("tr").dataset.i);
    cur.waypoints[i][k] = k === "action" ? e.target.value : Number(e.target.value);
    markDirty(); syncMap(); compute();
  });
  root.addEventListener("click", (e) => {
    const up = e.target.closest("[data-up]"), rm = e.target.closest("[data-rm]");
    if (up) { const i = Number(up.dataset.up); if (i > 0) { const w = cur.waypoints; [w[i - 1], w[i]] = [w[i], w[i - 1]]; } }
    else if (rm) cur.waypoints.splice(Number(rm.dataset.rm), 1);
    else { const tr = e.target.closest("#pl-wps tr[data-i]"); if (tr && e.target.tagName !== "INPUT") { const w = cur.waypoints[tr.dataset.i]; map.selWp = Number(tr.dataset.i); map.focus(w.lat, w.lon); map.setFollow(false); renderWps(); } return; }
    markDirty(); renderWps(); syncMap(); compute();
  });

  function renderPlan() {
    const el = $("#pl-plan"); if (!el) return;
    if (!plan) { el.innerHTML = ""; return; }
    const errs = (plan.issues || []);
    el.innerHTML = `
      <div class="summary">
        <div class="kv"><i>총 비행거리</i><b>${fmtDist(plan.total_distance_m)}</b></div>
        <div class="kv"><i>3D 거리</i><b>${fmtDist(plan.total_distance_3d_m)}</b></div>
        <div class="kv"><i>예상 비행시간</i><b>${fmtDur(plan.total_time_s)}</b></div>
        <div class="kv"><i>배터리 소모</i><b>${(plan.energy_pct ?? 0).toFixed(1)}%</b></div>
        <div class="kv"><i>착륙 시 잔량</i><b style="color:${plan.battery_end_pct < 20 ? "var(--red)" : plan.battery_end_pct < 30 ? "var(--amber)" : "var(--green)"}">${(plan.battery_end_pct ?? 0).toFixed(1)}%</b></div>
        <div class="kv"><i>최대 고도 / 거리</i><b>${(plan.max_alt_m ?? 0).toFixed(0)}m · ${fmtDist(plan.max_range_m)}</b></div>
      </div>
      <ul class="issues">${errs.length ? errs.map((i) => `<li class="${i.severity}">${i.severity === "ERROR" ? "오류" : "주의"} · ${esc(i.message)}</li>`).join("")
        : `<li class="ok">사전 검증 통과 — 금지구역·지오펜스·고도·거리·배터리 한계 이상 없음</li>`}</ul>
      ${plan.legs?.length ? `<div class="tbl-wrap"><table><thead><tr><th>구간</th><th class="num">수평거리</th><th class="num">방위</th><th class="num">고도변화</th><th class="num">속도</th><th class="num">시간</th><th class="num">소모</th><th class="num">잔량</th></tr></thead><tbody>
        ${plan.legs.map((l) => `<tr><td>${l.frm} → ${l.to}</td><td class="num">${fmtDist(l.distance_m)}</td><td class="num">${fmtBrg(l.bearing_deg)}</td>
          <td class="num">${l.alt_change_m > 0 ? "+" : ""}${l.alt_change_m.toFixed(0)} m</td><td class="num">${l.speed_mps.toFixed(1)}</td>
          <td class="num">${fmtDur(l.time_s)}</td><td class="num">${l.energy_pct.toFixed(1)}%</td><td class="num">${l.battery_after_pct.toFixed(1)}%</td></tr>`).join("")}
      </tbody></table></div>` : ""}`;
  }

  load();
  return { load, toggleEdit };
}

// =========================================================================
// 비행 기록 · 재생
// =========================================================================
function flights(ctx) {
  const { api, run, esc, map, fmtDateTime, fmtTime } = ctx;
  const root = $("#tab-flights");
  let list = [], sel = null, track = [], idx = 0, playing = false, speed = 4, timer = null;
  root.innerHTML = `<div class="split"><div><div class="btns"><button class="btn sm" type="button" id="fl-refresh">새로고침</button></div><div class="list" id="fl-list"></div></div>
    <div id="fl-detail"><div class="empty">비행 기록을 선택하면 경로 재생과 경보 이력을 볼 수 있습니다.</div></div></div>`;

  async function load() { const l = await run(() => api("GET", "/api/flights")); if (l) { list = l; renderList(); } }
  function renderList() {
    $("#fl-list").innerHTML = list.map((f) => `<button type="button" class="item ${sel?.id === f.id ? "sel" : ""}" data-fid="${f.id}">
      <span class="row"><b>비행 #${f.id} · ${esc(f.aircraft_id)}</b>${f.ended_at ? `<span class="badge">${fmtDur(f.ended_at - f.started_at)}</span>` : `<span class="badge ok">진행 중</span>`}</span>
      <small>${fmtDateTime(f.started_at)} · ${esc(f.operator || "—")}</small>
      <small>${esc(f.mission_name || "수동 비행")} · ${fmtDist(f.distance_m)} · 경보 ${f.alert_count}</small></button>`).join("") || `<div class="empty">비행 기록 없음</div>`;
  }
  $("#fl-refresh").addEventListener("click", load);
  $("#fl-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-fid]"); if (!b) return;
    const fid = Number(b.dataset.fid);
    const [f, tel] = await Promise.all([api("GET", `/api/flights/${fid}`), api("GET", `/api/flights/${fid}/telemetry`)]);
    sel = f; stop();
    track = tel.map((p) => ({ ...p, xy: map.proj.toXY(p.lat, p.lon) }));
    idx = 0; renderList(); renderDetail();
    map.setReplay(track, 0);
    if (track.length) { map.setFollow(false); map.focus(track[0].lat, track[0].lon); }
  });

  function renderDetail() {
    const f = sel, el = $("#fl-detail");
    el.innerHTML = `<div class="summary">
      <div class="kv"><i>운용자</i><b style="font-size:13px">${esc(f.operator || "—")}</b></div>
      <div class="kv"><i>사용 임무</i><b style="font-size:13px">${esc(f.mission_name || "수동")}</b></div>
      <div class="kv"><i>시작 / 종료</i><b style="font-size:12px">${fmtTime(f.started_at)} / ${fmtTime(f.ended_at)}</b></div>
      <div class="kv"><i>비행거리 / 최고고도</i><b>${fmtDist(f.distance_m)} · ${(f.max_alt_m || 0).toFixed(0)}m</b></div>
      <div class="kv"><i>종료 사유</i><b style="font-size:13px">${esc(f.end_reason || "—")}</b></div>
      <div class="kv"><i>스냅샷</i><b>${f.samples}</b></div></div>
      <div class="replay"><button class="btn sm primary" type="button" id="rp-play" ${track.length ? "" : "disabled"}>재생</button>
        <select id="rp-speed" class="sm" aria-label="재생 배속">${[1, 4, 16, 64].map((s) => `<option value="${s}" ${s === speed ? "selected" : ""}>${s}×</option>`).join("")}</select>
        <input type="range" id="rp-pos" min="0" max="${Math.max(0, track.length - 1)}" value="0" aria-label="재생 위치">
        <span class="mono" id="rp-time">—</span><button class="btn sm" type="button" id="rp-close">재생 종료</button></div>
      <div class="mono muted" id="rp-read" style="font-size:12.5px;margin-bottom:8px">—</div>
      <h3 style="font-size:13px;margin:8px 0 4px">비행 중 경보 이력 (${f.alerts.length})</h3>
      <div class="tbl-wrap"><table><thead><tr><th>발생</th><th>심각도</th><th>코드</th><th>내용</th><th>원인</th><th>인지</th><th>해제</th></tr></thead><tbody>
      ${f.alerts.map((a) => `<tr><td>${fmtTime(a.raised_at)}</td><td><span class="badge ${ctx.SEV_BADGE[a.severity]}">${a.severity}</span></td><td>${esc(a.code)}</td><td>${esc(a.message)}</td><td>${esc(a.cause)}</td><td>${a.acked_at ? `${fmtTime(a.acked_at)} ${esc(a.acked_by_name || "")}` : "—"}</td><td>${fmtTime(a.cleared_at)}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">경보 없음</td></tr>`}
      </tbody></table></div>`;
    $("#rp-play").addEventListener("click", () => (playing ? stop() : play()));
    $("#rp-speed").addEventListener("change", (e) => (speed = Number(e.target.value)));
    $("#rp-pos").addEventListener("input", (e) => { idx = Number(e.target.value); show(); });
    $("#rp-close").addEventListener("click", () => { stop(); map.setReplay(null); });
    show();
  }
  function show() {
    const p = track[idx]; if (!p) return;
    map.setReplay(track, idx);
    const pos = $("#rp-pos"); if (pos) pos.value = idx;
    const t = $("#rp-time"); if (t) t.textContent = `${fmtDur(p.t - track[0].t)} / ${fmtDur(track[track.length - 1].t - track[0].t)}`;
    const r = $("#rp-read");
    if (r) r.textContent = `${p.mode} · 고도 ${p.alt_rel?.toFixed(1)}m · 속도 ${p.groundspeed?.toFixed(1)}m/s · 기수 ${fmtBrg(p.heading)} · 배터리 ${p.battery_pct?.toFixed(1)}% · GNSS ${p.gps?.sats ?? "—"}sat · 링크 ${p.link?.connected ? `${p.link.latency_ms}ms` : "단절"}`;
  }
  function play() {
    if (!track.length) return;
    if (idx >= track.length - 1) idx = 0;
    playing = true; $("#rp-play").textContent = "일시정지";
    let clock = track[idx].t;
    timer = setInterval(() => {
      clock += 0.1 * speed;
      while (idx < track.length - 1 && track[idx + 1].t <= clock) idx++;
      show();
      if (idx >= track.length - 1) stop();
    }, 100);
  }
  function stop() { playing = false; clearInterval(timer); const b = $("#rp-play"); if (b) b.textContent = "재생"; }
  load();
  return { load };
}

// =========================================================================
// 정비 이력
// =========================================================================
function maintenance(ctx) {
  const { api, run, esc, can, fmtDateTime, STATUS_BADGE, STATUS_LABEL } = ctx;
  const root = $("#tab-maint");
  let aircraft = [], logs = [], filter = "";
  async function load() {
    const [ac, ml] = await Promise.all([api("GET", "/api/aircraft"), api("GET", "/api/maintenance")]);
    aircraft = ac.aircraft; logs = ml; render();
  }
  function render() {
    const w = can("maint.write");
    root.innerHTML = `<div class="cols">
      <div class="card"><h3>기체 가용 상태</h3>
        <div class="list">${aircraft.map((a) => {
          const last = logs.find((l) => l.aircraft_id === a.id);
          return `<div class="item" style="cursor:default"><span class="row"><b>${esc(a.id)} ${esc(a.name)}</b><span class="badge ${STATUS_BADGE[a.status]}">${a.status}</span></span>
            <small>${esc(a.model)} · 누적 비행 ${fmtDur(a.total_flight_s)}</small>
            <small>최근 정비: ${last ? `${esc(last.date)} ${esc(last.mtype)} (${esc(last.technician)})` : "기록 없음"}</small>
            <small>${a.status === "AIRWORTHY" ? "임무 투입 가능" : "이륙·임무 시작 서버 차단 대상"}</small></div>`;
        }).join("")}</div></div>
      <div class="card"><h3>정비 기록 등록 ${w ? "" : '<span class="badge">권한 없음 · 보기 전용</span>'}</h3>
        <form id="mt-form" ${w ? "" : 'inert class="readonly"'}>
          <div class="form-row">
            <div class="fld"><label for="mt-ac">기체</label><select id="mt-ac">${aircraft.map((a) => `<option value="${esc(a.id)}">${esc(a.id)} ${esc(a.name)}</option>`).join("")}</select></div>
            <div class="fld"><label for="mt-date">점검 일자</label><input id="mt-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="fld"><label for="mt-tech">작업자</label><input id="mt-tech" value="${esc(ctx.S.me.display_name.split(" ")[0])}"></div>
            <div class="fld"><label for="mt-type">정비 유형</label><select id="mt-type"><option>정기점검</option><option>수리</option><option>부품교체</option></select></div>
          </div>
          <div class="checklist">${CHECK_ITEMS.map((c, i) => `<label><input type="checkbox" data-ci="${i}" checked> ${esc(c)}</label>`).join("")}</div>
          <div class="fld"><label for="mt-notes">작업 내용 / 비고</label><textarea id="mt-notes" rows="2"></textarea></div>
          <div class="form-row" style="margin-top:8px">
            <div class="fld"><label for="mt-result">정비 후 기체 상태</label><select id="mt-result">
              <option value="AIRWORTHY">AIRWORTHY — 비행 가능</option><option value="MAINTENANCE_REQUIRED">MAINTENANCE_REQUIRED — 정비 필요</option><option value="GROUNDED">GROUNDED — 비행 불가</option></select></div>
            <button class="btn primary" type="submit">기록 저장</button>
          </div>
          <p class="muted" style="font-size:12px;margin:4px 0 0">점검 항목에 불량(체크 해제)이 있으면 AIRWORTHY로 저장할 수 없습니다.</p>
        </form></div></div>
      <div class="form-row" style="margin-top:12px"><div class="fld"><label for="mt-filter">이력 필터</label><select id="mt-filter"><option value="">전체 기체</option>${aircraft.map((a) => `<option ${filter === a.id ? "selected" : ""}>${esc(a.id)}</option>`).join("")}</select></div></div>
      <div class="tbl-wrap"><table><thead><tr><th>일자</th><th>기체</th><th>유형</th><th>작업자</th><th>점검 항목</th><th>비고</th><th>결과 상태</th><th>등록</th></tr></thead><tbody>
      ${logs.filter((l) => !filter || l.aircraft_id === filter).map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.aircraft_id)}</td><td>${esc(l.mtype)}</td><td>${esc(l.technician)}</td>
        <td style="white-space:normal;min-width:220px">${l.checklist.map((c) => `${c.ok ? "✓" : "✗"} ${esc(c.item)}`).join("<br>")}</td>
        <td style="white-space:normal;min-width:160px">${esc(l.notes)}</td><td><span class="badge ${STATUS_BADGE[l.result_status]}">${l.result_status}</span></td><td>${fmtDateTime(l.created_at)}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">정비 이력 없음</td></tr>`}
      </tbody></table></div>`;
    $("#mt-filter").addEventListener("change", (e) => { filter = e.target.value; render(); });
    $("#mt-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const checklist = CHECK_ITEMS.map((item, i) => ({ item, ok: $(`[data-ci="${i}"]`).checked }));
      const result = $("#mt-result").value;
      if (result === "AIRWORTHY" && checklist.some((c) => !c.ok)) return ctx.toast("불량 항목이 있어 AIRWORTHY로 저장할 수 없습니다", "err");
      const r = await run(() => api("POST", "/api/maintenance", { aircraft_id: $("#mt-ac").value, date: $("#mt-date").value, technician: $("#mt-tech").value,
        mtype: $("#mt-type").value, checklist, notes: $("#mt-notes").value, result_status: result }), "정비 기록 저장 · 기체 상태 반영");
      if (r) { await load(); ctx.refreshAircraft(); }
    });
  }
  load();
  return { load };
}

// =========================================================================
// 시뮬레이터 제어 (장애 주입)
// =========================================================================
function simulator(ctx) {
  const { api, run, can, esc } = ctx;
  const root = $("#tab-sim");
  const w = can("sim.control");
  root.innerHTML = `${w ? "" : `<p class="muted">${esc(ctx.S.me.role_label)} 역할은 시뮬레이터 제어 권한이 없습니다 (임무통제관·정비사 전용). 현재 값만 표시됩니다.</p>`}
  <div class="sim-grid ${w ? "" : "readonly"}" ${w ? "" : "inert"}>
    <div class="card"><h3>데이터링크</h3>
      <div class="row"><span>링크 단절</span><button class="btn sm toggle" type="button" id="sim-down">정상</button></div>
      <div class="row"><label for="sim-lat">지연</label><input type="range" id="sim-lat" min="0" max="3000" step="50"><b class="mono" id="sim-lat-v"></b></div>
      <div class="row"><label for="sim-loss">패킷 손실</label><input type="range" id="sim-loss" min="0" max="80"><b class="mono" id="sim-loss-v"></b></div>
      <div class="row"><label for="sim-cor">비트 오류</label><input type="range" id="sim-cor" min="0" max="30"><b class="mono" id="sim-cor-v"></b></div></div>
    <div class="card"><h3>전원 · 환경</h3>
      <div class="row"><label for="sim-drain">배터리 소모 배율</label><input type="range" id="sim-drain" min="1" max="20" step="0.5"><b class="mono" id="sim-drain-v"></b></div>
      <div class="row"><span>배터리 급감</span><button class="btn sm warn" type="button" id="sim-drop">−20%</button></div>
      <div class="row"><label for="sim-wind">측풍(서→동)</label><input type="range" id="sim-wind" min="0" max="15" step="0.5"><b class="mono" id="sim-wind-v"></b></div>
      <div class="row"><span>GNSS 수신 저하</span><button class="btn sm toggle" type="button" id="sim-gps">정상</button></div></div>
    <div class="card"><h3>시나리오</h3>
      <div class="btns" style="flex-direction:column;align-items:stretch">
        <button class="btn sm" type="button" data-sc="cut15">링크 단절 15초 후 자동 복구 (페일세이프 RTL 확인)</button>
        <button class="btn sm" type="button" data-sc="lag">지연 1500 ms + 손실 25%</button>
        <button class="btn sm" type="button" data-sc="batt">배터리 급감 (→ 위험 임계치)</button>
        <button class="btn sm" type="button" data-sc="clear">장애 모두 해제</button>
        <button class="btn sm danger" type="button" data-sc="reset">기체 시뮬레이터 초기화 (지상)</button></div></div>
  </div>`;
  const post = (body, msg) => run(() => api("POST", "/api/sim", body), msg);
  const sliders = [["sim-lat", "latency_ms", (v) => `${v} ms`], ["sim-loss", "loss_pct", (v) => `${v}%`], ["sim-cor", "corrupt_pct", (v) => `${v}%`],
    ["sim-drain", "battery_drain_x", (v) => `×${v}`], ["sim-wind", "wind_mps", (v) => `${v} m/s`]];
  for (const [id, key, f] of sliders) {
    const el = $(`#${id}`);
    el.addEventListener("input", () => ($(`#${id}-v`).textContent = f(el.value)));
    el.addEventListener("change", () => post({ [key]: Number(el.value) }));
  }
  $("#sim-down").addEventListener("click", () => post({ link_down: !ctx.S.state?.sim?.link_down }, ctx.S.state?.sim?.link_down ? "링크 복구" : "링크 단절 주입"));
  $("#sim-gps").addEventListener("click", () => post({ gps_degraded: !ctx.S.state?.sim?.gps_degraded }));
  $("#sim-drop").addEventListener("click", () => post({ action: "battery_drop", pct: 20 }, "배터리 20% 급감 주입"));
  root.querySelectorAll("[data-sc]").forEach((b) => b.addEventListener("click", async () => {
    const sc = b.dataset.sc;
    if (sc === "cut15") { await post({ link_down: true }, "링크 단절 — 15초 후 복구"); setTimeout(() => post({ link_down: false }, "링크 복구"), 15000); }
    if (sc === "lag") post({ latency_ms: 1500, loss_pct: 25 }, "지연/손실 주입");
    if (sc === "batt") { const b0 = ctx.S.state?.telemetry?.battery_pct ?? 100; post({ action: "battery_drop", pct: Math.max(0, b0 - 14) }, "배터리 급감 주입"); }
    if (sc === "clear") post({ link_down: false, latency_ms: 25, loss_pct: 0, corrupt_pct: 0, battery_drain_x: 1, wind_mps: 0, gps_degraded: false }, "장애 해제");
    if (sc === "reset") post({ action: "reset" }, "시뮬레이터 초기화");
  }));
  let last = "";
  function sync(st) {
    const s = st.sim; if (!s) return;
    const key = JSON.stringify(s); if (key === last) return; last = key;
    const set = (id, v, f) => { const el = $(`#${id}`); if (document.activeElement !== el) el.value = v; $(`#${id}-v`).textContent = f(v); };
    set("sim-lat", s.latency_ms, (v) => `${v} ms`); set("sim-loss", s.loss_pct, (v) => `${v}%`); set("sim-cor", s.corrupt_pct, (v) => `${v}%`);
    set("sim-drain", s.battery_drain_x, (v) => `×${v}`); set("sim-wind", s.wind_mps, (v) => `${v} m/s`);
    const d = $("#sim-down"); d.textContent = s.link_down ? "단절됨" : "정상"; d.classList.toggle("on", s.link_down);
    const g = $("#sim-gps"); g.textContent = s.gps_degraded ? "저하됨" : "정상"; g.classList.toggle("on", s.gps_degraded);
  }
  return { sync };
}

// =========================================================================
// 감사 로그
// =========================================================================
function audit(ctx) {
  const { api, run, esc, can, fmtDateTime } = ctx;
  const root = $("#tab-audit");
  let only = "";
  async function load() {
    if (!can("audit.read")) { root.innerHTML = `<p class="muted">감사 로그 열람은 임무통제관(MISSION_CTRL) 권한입니다. 요청하면 서버가 403으로 거부하고 그 시도도 기록됩니다.</p>`; return; }
    const rows = await run(() => api("GET", `/api/audit?limit=300${only ? `&result=${only}` : ""}`));
    if (!rows) return;
    root.innerHTML = `<div class="btns"><div class="seg" role="group" aria-label="결과 필터">
      <button type="button" data-f="" class="${only ? "" : "on"}">전체</button><button type="button" data-f="DENIED" class="${only === "DENIED" ? "on" : ""}">거부(DENIED)</button><button type="button" data-f="ERROR" class="${only === "ERROR" ? "on" : ""}">오류</button></div>
      <button class="btn sm" type="button" id="au-refresh">새로고침</button></div>
      <div class="tbl-wrap" style="max-height:420px"><table><thead><tr><th>시각</th><th>사용자</th><th>역할</th><th>행위</th><th>대상</th><th>결과</th><th>상세</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.result === "DENIED" ? "denied" : ""}"><td>${fmtDateTime(r.t)}</td><td>${esc(r.username || "—")}</td><td>${esc(r.role || "—")}</td><td>${esc(r.action)}</td><td>${esc(r.target || "")}</td>
        <td><span class="badge ${r.result === "ALLOWED" ? "ok" : r.result === "DENIED" ? "crit" : "warn"}">${r.result}</span></td>
        <td style="white-space:normal;min-width:240px;font-family:var(--mono);font-size:11.5px">${esc(r.detail.reason || r.detail.ack?.message || JSON.stringify(r.detail)).slice(0, 220)}</td></tr>`).join("")}
      </tbody></table></div>`;
    root.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { only = b.dataset.f; load(); }));
    $("#au-refresh").addEventListener("click", load);
  }
  return { load };
}
