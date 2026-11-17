/*
 * KIT 공강 산책 — 화면(UI) 계층
 * ------------------------------------------------------------
 *  데이터(data/) · 처리(js/engine.js, js/photo-matcher.js) · 시스템 연동(js/weather.js, js/context.js, js/timetable.js)을 묶어
 *  인트로, 상황별 실사 포토 프리뷰, 지도 SVG 오버레이(계절·시간대 하이라이트), 조건 입력·상황 시뮬레이터,
 *  추천 카드, 산책 타이머, 시간표, 기록/즐겨찾기 화면을 렌더링합니다.
 *  영속 데이터는 localStorage에 저장하며, 저장소를 쓸 수 없는 환경에서는 메모리로 대체합니다.
 */
(function () {
  'use strict';

  var D = window.KITWalkData, PH = window.KITWalkPhotos, E = window.KITWalkEngine, W = window.KITWalkWeather,
    C = window.KITWalkContext, M = window.KITWalkPhotoMatcher, T = window.KITWalkTimetable;
  if (!D || !PH || !E || !W || !C || !M || !T) {
    var f = document.getElementById('fatal');
    if (f) f.hidden = false;
    document.body.classList.remove('intro-on');
    var it = document.getElementById('intro'); if (it) it.hidden = true;
    return;
  }

  /* =========================================================
   * 인트로 (웹사이트 인트로.gif) — 앱 초기화와 병렬로 진행
   * ========================================================= */
  var intro = (function () {
    var el = document.getElementById('intro'), img = document.getElementById('introImg'), bar = document.getElementById('introBar');
    var dur = (PH.ASSETS.intro && PH.ASSETS.intro.durationMs) || 3200;
    var timer = null, closed = false;
    try { if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) dur = 1400; } catch (e) { /* noop */ }
    function close() {
      if (closed) return;
      closed = true; clearTimeout(timer);
      el.classList.add('out');
      document.body.classList.remove('intro-on');
      setTimeout(function () { el.hidden = true; }, 450);
    }
    function play() {
      closed = false; el.hidden = false; el.classList.remove('out');
      el.style.animation = 'none'; // CSS 안전장치(스크립트 실패 시 9초 후 자동 숨김)는 JS가 동작하면 해제
      document.body.classList.add('intro-on');
      bar.style.transition = 'none'; bar.style.width = '0%';
      // gif를 처음부터 다시 재생하기 위해 src 재설정
      var src = M.photoUrl(PH.ASSETS.intro.file);
      img.src = ''; img.src = src;
      var started = false;
      function start() {
        if (started || closed) return;
        started = true;
        requestAnimationFrame(function () { bar.style.transition = 'width ' + dur + 'ms linear'; bar.style.width = '100%'; });
        timer = setTimeout(close, dur + 250);
      }
      if (img.complete && img.naturalWidth) start();
      img.onload = start;
      img.onerror = function () { close(); };
      setTimeout(start, 2500); // 느린 네트워크: 2.5초 안에 못 받아도 진행
    }
    if (/[?&]nointro\b/.test(location.search)) { el.hidden = true; document.body.classList.remove('intro-on'); closed = true; }
    else play();
    document.getElementById('introSkip').addEventListener('click', close);
    el.addEventListener('click', function (ev) { if (ev.target === el) close(); });
    document.addEventListener('keydown', function (ev) { if (!closed && (ev.key === 'Escape' || ev.key === 'Enter')) close(); });
    return { play: play, close: close };
  })();

  /* =========================================================
   * 저장소
   * ========================================================= */
  var KEYS = {
    prefs: 'kitwalk.v1.prefs', timetable: 'kitwalk.v1.timetable', history: 'kitwalk.v1.history',
    favorites: 'kitwalk.v1.favorites', weatherCache: 'kitwalk.v1.weatherCache', coords: 'kitwalk.v1.coordOverrides',
    active: 'kitwalk.v1.activeWalk', clock: 'kitwalk.v1.clockOffset'
  };
  var store = (function () {
    var mem = {}, ok = false;
    try { localStorage.setItem('__kw', '1'); localStorage.removeItem('__kw'); ok = true; } catch (e) { ok = false; }
    return {
      persistent: ok,
      get: function (k, def) {
        try { var raw = ok ? localStorage.getItem(k) : mem[k]; return raw == null ? def : JSON.parse(raw); } catch (e) { return def; }
      },
      set: function (k, v) {
        var raw = JSON.stringify(v);
        try { if (ok) localStorage.setItem(k, raw); else mem[k] = raw; } catch (e) { mem[k] = raw; }
      },
      del: function (k) { try { if (ok) localStorage.removeItem(k); } catch (e) { /* noop */ } delete mem[k]; }
    };
  })();

  /* =========================================================
   * 상태
   * ========================================================= */
  var DEFAULT_PREFS = { start: 'digital', end: 'techno', avail: 40, speed: 'normal', theme: 'auto', buffer: 5, weatherMode: 'live', seasonMode: 'auto', timeMode: 'auto' };
  var WEATHER_MODES = [
    { id: 'live', label: '실시간' }, { id: 'clear', label: '맑음' }, { id: 'rain', label: '비' },
    { id: 'hot', label: '폭염' }, { id: 'cold', label: '추위·강풍' }, { id: 'dust', label: '미세먼지' }, { id: 'snow', label: '눈' }
  ];
  var SEASON_MODES = [{ id: 'auto', label: '자동' }, { id: 'spring', label: '봄' }, { id: 'summer', label: '여름' }, { id: 'autumn', label: '가을' }, { id: 'winter', label: '겨울' }];
  var TIME_MODES = [{ id: 'auto', label: '자동' }, { id: 'day', label: '낮' }, { id: 'sunset', label: '저녁' }, { id: 'night', label: '야간' }];
  var LEG_COLORS = ['#1565c0', '#1d7a4f', '#d0811c', '#8b4fc0', '#c4372d'];
  var MAP_W = D.MAP.width, MAP_H = D.MAP.height;

  var state = {
    prefs: assign({}, DEFAULT_PREFS, store.get(KEYS.prefs, {})),
    overrides: store.get(KEYS.coords, {}) || {},
    engine: null, data: null,
    weather: { obs: null, source: 'fallback', updatedAt: null, error: null, cls: null, suit: null, loading: false },
    ctx: null,
    result: null, selectedKey: null, pinned: null, focusSpot: null, heroPick: null,
    timetable: null, history: store.get(KEYS.history, []) || [], favorites: store.get(KEYS.favorites, []) || [],
    clockOffset: Number(store.get(KEYS.clock, 0)) || 0,
    active: store.get(KEYS.active, null),
    zoom: (window.innerWidth || 1024) < 600 ? 1.6 : 1, showNames: false, showNet: false, showLegend: false,
    calib: { on: false, selected: null },
    tab: 'plan', userPicked: false, timerFolded: false, notifiedReturn: false, autoLinked: false, lastMinute: null
  };
  var tt = store.get(KEYS.timetable, null);
  state.timetable = Array.isArray(tt) ? tt : T.sampleTimetable();
  if (!Array.isArray(tt)) store.set(KEYS.timetable, state.timetable);

  /* =========================================================
   * 유틸
   * ========================================================= */
  function $(id) { return document.getElementById(id); }
  function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) t[k] = s[k]; } return t; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function now() { return new Date(Date.now() + state.clockOffset); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtMin(m) {
    m = Math.round(m);
    if (Math.abs(m) < 60) return m + '분';
    var h = Math.floor(Math.abs(m) / 60), r = Math.abs(m) % 60;
    return (m < 0 ? '-' : '') + h + '시간' + (r ? ' ' + r + '분' : '');
  }
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + 'km' : Math.round(m) + 'm'; }
  function fmtCountdown(ms) {
    var neg = ms < 0, s = Math.floor(Math.abs(ms) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (neg ? '-' : '') + (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(ss);
  }
  function nodeName(id) { var n = state.engine.graph.nodes[id]; return n ? n.name : id; }
  function savePrefs() { store.set(KEYS.prefs, state.prefs); }
  function imgTag(photo, cls, attrs) {
    if (!photo) return '';
    return '<img class="' + (cls || '') + '" src="' + esc(M.photoUrl(photo.file)) + '" alt="' + esc(photo.caption) + '" loading="lazy" decoding="async"' +
      (photo.w ? ' width="' + photo.w + '" height="' + photo.h + '"' : '') + (attrs || '') + '>';
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2400);
  }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  /* =========================================================
   * 데이터 + 엔진 (좌표 보정값 반영)
   * ========================================================= */
  function buildData() {
    var ov = state.overrides || {};
    function mapNode(n) { var o = ov[n.id]; return o ? assign({}, n, { x: o.x, y: o.y }) : n; }
    return assign({}, D, { LANDMARKS: D.LANDMARKS.map(mapNode), WAYPOINTS: D.WAYPOINTS.map(mapNode) });
  }
  function rebuildEngine() { state.data = buildData(); state.engine = E.createEngine(state.data); }

  /* =========================================================
   * 상황(계절·시간대) + 날씨
   * ========================================================= */
  function updateContext() {
    var o = state.weather.obs;
    var sun = o && o.sunrise && o.sunset && state.prefs.weatherMode === 'live' && !state.clockOffset ? { sunrise: o.sunrise, sunset: o.sunset } : null;
    state.ctx = C.resolveContext(now(), sun, { season: state.prefs.seasonMode, time: state.prefs.timeMode });
    document.documentElement.setAttribute('data-time', state.ctx.time);
    document.documentElement.setAttribute('data-season', state.ctx.season);
  }
  function weatherKey() { return state.weather.cls ? state.weather.cls.category : 'clear'; }
  function currentProfile() { return E.composeProfile(weatherKey(), state.ctx.season, state.ctx.time); }

  function setWeather(obs, source, extra) {
    state.weather.obs = obs;
    state.weather.source = source;
    state.weather.cls = W.classify(obs);
    state.weather.suit = W.suitability(obs);
    assign(state.weather, extra || {});
    updateContext();
    renderWeather();
    recompute();
  }

  function loadWeather() {
    var mode = state.prefs.weatherMode;
    if (mode !== 'live') {
      setWeather(W.presetObs(mode), 'test', { updatedAt: now(), error: null, loading: false });
      return;
    }
    var cache = store.get(KEYS.weatherCache, null);
    var fresh = cache && cache.obs && (Date.now() - cache.at) < 3 * 3600 * 1000;
    if (!state.weather.obs) {
      if (fresh) setWeather(cache.obs, 'cache', { updatedAt: new Date(cache.at), loading: true });
      else setWeather(W.fallbackObs(now()), 'fallback', { updatedAt: null, loading: true });
    }
    state.weather.loading = true;
    renderWeather();
    W.fetchWeather({ timeoutMs: 7000 }).then(function (obs) {
      if (state.prefs.weatherMode !== 'live') return;
      store.set(KEYS.weatherCache, { at: Date.now(), obs: obs });
      setWeather(obs, 'live', { updatedAt: new Date(), error: null, loading: false });
    }).catch(function (err) {
      if (state.prefs.weatherMode !== 'live') return;
      var c = store.get(KEYS.weatherCache, null);
      var ok = c && c.obs && (Date.now() - c.at) < 3 * 3600 * 1000;
      var msg = (err && err.message) || '네트워크 오류';
      if (ok) setWeather(c.obs, 'cache', { updatedAt: new Date(c.at), error: msg, loading: false });
      else setWeather(W.fallbackObs(now()), 'fallback', { updatedAt: null, error: msg, loading: false });
    });
  }

  var SOURCE_LABEL = { live: ['실시간 · Open-Meteo', 'ok'], cache: ['최근 조회값', 'water'], fallback: ['기본값(오프라인)', 'warn'], test: ['테스트 날씨', 'warn'] };
  var SEASON_CHIP = { spring: 'pink', summer: 'water', autumn: 'warn', winter: '' };
  var TIME_CHIP = { day: 'ok', sunset: 'warn', night: 'night' };

  function renderWeather() {
    var w = state.weather, o = w.obs, cx = state.ctx;
    var src = SOURCE_LABEL[w.source] || SOURCE_LABEL.fallback;
    var srcEl = $('wxSource');
    srcEl.textContent = w.loading && w.source !== 'test' ? '불러오는 중…' : src[0];
    srcEl.className = 'chip ' + (w.loading ? '' : src[1]);
    if (!o) return;
    $('wxTemp').textContent = Math.round(o.tempC);
    $('wxLabel').textContent = W.describeCode(o.code);
    var catEl = $('wxCat');
    catEl.textContent = w.cls.label;
    catEl.className = 'chip ' + ({ clear: 'ok', rain: 'water', snow: 'water', hot: 'bad', cold: 'warn', dust: 'warn' }[w.cls.category] || '');
    if (cx) {
      $('seasonChip').textContent = cx.seasonLabel + (cx.simulatedSeason ? '(시뮬)' : '');
      $('seasonChip').className = 'chip ' + SEASON_CHIP[cx.season];
      $('timeChip').textContent = cx.timeLabel + (cx.simulatedTime ? '(시뮬)' : '');
      $('timeChip').className = 'chip ' + TIME_CHIP[cx.time];
      $('seasonAuto').textContent = '자동 판별: ' + C.SEASONS[cx.autoSeason].label;
      $('timeAuto').textContent = '자동 판별: ' + C.TIMES[cx.autoTime].label + (o.sunset && state.prefs.weatherMode === 'live' && !state.clockOffset ? ' (일몰 ' + String(o.sunset).slice(11, 16) + ')' : '');
      $('ctxChip').textContent = cx.seasonLabel + ' · ' + cx.timeLabel + ' · ' + w.cls.label;
    }
    $('wxFeel').textContent = (o.apparentC != null ? Math.round(o.apparentC) : '-') + '°';
    $('wxPrecip').textContent = (o.precipMm || 0) + 'mm';
    $('wxWind').textContent = (o.windMs != null ? o.windMs.toFixed(1) : '-') + 'm/s';
    $('wxHum').textContent = o.humidity != null ? Math.round(o.humidity) + '%' : '-';
    $('wxDust').textContent = o.pm10 != null ? Math.round(o.pm10) + '㎍' : '-';
    var s = w.suit, b = $('wxSuitBadge');
    b.textContent = s.level.label + ' · ' + s.score;
    b.className = 'badge ' + s.level.id;
    var bar = $('wxSuitBar');
    bar.style.width = s.score + '%';
    bar.style.background = s.score >= 55 ? 'var(--ok)' : s.score >= 35 ? 'var(--warn)' : 'var(--bad)';
    if (cx) $('wxTips').innerHTML = currentProfile().tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    var meta = [];
    if (w.source === 'live' && w.updatedAt) meta.push(hm(w.updatedAt) + ' 기준 실시간 관측');
    if (w.source === 'cache' && w.updatedAt) meta.push(hm(w.updatedAt) + '에 조회한 값을 사용 중');
    if (w.source === 'fallback') meta.push('날씨 API에 연결하지 못해 계절 기본값을 사용 중');
    if (w.source === 'test') meta.push('테스트 날씨 "' + (W.PRESETS[state.prefs.weatherMode] || {}).label + '" 적용 중');
    if (w.error && w.source !== 'test') meta.push('(' + w.error + ')');
    $('wxMeta').textContent = meta.join(' ');
    renderSeg('wxModeSeg', WEATHER_MODES, state.prefs.weatherMode);
    renderSeg('seasonSeg', SEASON_MODES, state.prefs.seasonMode);
    renderSeg('timeSeg', TIME_MODES, state.prefs.timeMode);
  }

  /* =========================================================
   * 조건 입력 폼
   * ========================================================= */
  function buildingOptions(sel) {
    return D.LANDMARKS.slice().sort(function (a, b) { return a.num - b.num; }).map(function (n) {
      return '<option value="' + n.id + '"' + (n.id === sel ? ' selected' : '') + '>' + n.num + '. ' + esc(n.name) + '</option>';
    }).join('');
  }
  function renderSeg(id, items, value) {
    $(id).innerHTML = items.map(function (it) {
      return '<button type="button" role="radio" data-v="' + it.id + '" aria-checked="' + (it.id === value) + '"' +
        (it.desc ? ' title="' + esc(it.desc) + '"' : '') + '>' + esc(it.label) + '</button>';
    }).join('');
  }
  function writeSegs() {
    renderSeg('speedSeg', Object.keys(E.SPEEDS).map(function (k) { return { id: k, label: E.SPEEDS[k].label }; }), state.prefs.speed);
    renderSeg('themeChips', D.THEMES, state.prefs.theme);
  }
  function writeForm() {
    var p = state.prefs;
    $('start').innerHTML = buildingOptions(p.start);
    $('end').innerHTML = buildingOptions(p.end);
    setAvail(p.avail, true);
    writeSegs();
    $('buffer').value = String(p.buffer);
  }
  function setAvail(v, silent) {
    v = Math.max(5, Math.min(120, Math.round(Number(v) || 0)));
    state.prefs.avail = v;
    $('avail').value = v;
    $('availOut').textContent = fmtMin(v);
    if (!silent) { savePrefs(); recomputeSoon(); }
  }

  function autofillFromTimetable(silent) {
    var info = $('autofillInfo');
    var r = T.nextClass(state.timetable, now());
    if (!state.timetable.length) {
      info.textContent = '등록된 시간표가 없어요. [내 시간표]에서 수업을 추가하세요.';
      if (!silent) toast('시간표가 비어 있어요');
      return false;
    }
    if (!r.next) {
      info.textContent = r.dayLabel + '요일 ' + hm(now()) + ' 기준 오늘 남은 수업이 없어요.' + (r.current ? ' (지금은 ' + r.current.title + ' 수업 중)' : '');
      if (!silent) toast('오늘 남은 수업이 없어요');
      return false;
    }
    var p = state.prefs;
    p.end = r.next.building;
    if (r.fromBuilding) p.start = r.fromBuilding;
    $('start').value = p.start; $('end').value = p.end;
    setAvail(r.minutesUntil, true);
    state.pinned = null;
    var txt = r.dayLabel + ' ' + r.next.start + ' ' + r.next.title + '(' + nodeName(r.next.building) + ')까지 ' + fmtMin(r.minutesUntil) + ' 남음';
    if (r.current) txt = '지금은 ' + r.current.title + ' 수업 중(~' + r.current.end + '). 다음: ' + txt;
    else if (r.prev) txt += ' · 직전 수업: ' + r.prev.title + '(' + nodeName(r.prev.building) + ')';
    if (r.minutesUntil > 120) txt += ' · 슬라이더 최대 2시간으로 계산';
    info.textContent = txt;
    state.autoLinked = true;
    savePrefs();
    recompute();
    if (!silent) toast('시간표에서 다음 수업을 불러왔어요');
    return true;
  }

  /* =========================================================
   * 추천 계산 & 결과 렌더링
   * ========================================================= */
  var recomputeSoon = debounce(function () { recompute(); }, 120);

  function ctxOpts() {
    var p = state.prefs;
    return {
      start: p.start, end: p.end, availableMin: p.avail, speed: p.speed, theme: p.theme, bufferMin: Number(p.buffer),
      weather: weatherKey(), season: state.ctx.season, time: state.ctx.time
    };
  }

  function recompute() {
    if (!state.engine || !state.weather.cls || !state.ctx) return;
    var c = ctxOpts();
    try { state.result = state.engine.recommend(c); }
    catch (e) {
      state.result = null;
      $('cards').innerHTML = '<div class="empty">추천 계산 중 오류: ' + esc(e.message) + '</div>';
      return;
    }
    if (state.pinned) {
      var pc = state.engine.evaluateCourse({ start: c.start, end: c.end, spots: state.pinned.spots }, c);
      state.pinned.course = pc;
      if (pc) pc.rank = '★';
    }
    var list = visibleCourses();
    if (!list.some(function (x) { return x.key === state.selectedKey; })) state.selectedKey = list[0] ? list[0].key : null;
    renderResults();
    drawRoute();
    renderHero();
  }

  function visibleCourses() {
    var r = state.result, list = r ? r.courses.slice() : [];
    if (state.pinned && state.pinned.course) {
      list = list.filter(function (c) { return c.key !== state.pinned.course.key; });
      list.unshift(state.pinned.course);
    }
    return list;
  }
  function selectedCourse() {
    var list = visibleCourses();
    for (var i = 0; i < list.length; i++) if (list[i].key === state.selectedKey) return list[i];
    return null;
  }
  function favKey(c) { return c.start + '>' + c.spots.join('>') + '>' + c.end; }
  function isFav(c) { var k = favKey(c); return state.favorites.some(function (f) { return favKey(f) === k; }); }
  function photoQuery(extra) {
    return assign({ season: state.ctx.season, time: state.ctx.time, weather: weatherKey() }, extra || {});
  }
  function coursePhoto(c) { return M.selectContextualPhoto(photoQuery({ stops: c.stops })).hero; }

  var STATUS_CHIP = { SAFE: 'ok', TIGHT: 'warn', OVER: 'bad' };

  function renderResults() {
    var r = state.result, p = state.prefs, cx = state.ctx;
    $('resCtx').textContent = nodeName(p.start) + ' → ' + nodeName(p.end) + ' · ' + fmtMin(p.avail) + ' · ' +
      E.SPEEDS[p.speed].label + ' · ' + state.weather.cls.label + ' · ' + cx.seasonLabel + ' · ' + cx.timeLabel + ' · 버퍼 ' + p.buffer + '분';
    var warn = $('resWarn'), msgs = [];
    if (r && r.warning) msgs.push(r.warning);
    var wk = weatherKey();
    if ((wk === 'rain' || wk === 'snow') && (p.theme === 'nature' || p.theme === 'active' || p.theme === 'seasonal'))
      msgs.push('궂은 날씨라 선택한 테마보다 실내·건물 인접 코스를 우선했어요.');
    if (cx.time === 'night' && p.theme === 'nature') msgs.push('야간에는 어두운 숲길을 감점해 조명이 있는 길을 우선했어요.');
    if (state.pinned && !state.pinned.course) msgs.push('즐겨찾기 코스 "' + state.pinned.title + '"는 현재 날씨 조건(흙길 제외 등)에서 이용할 수 없어요.');
    warn.hidden = !msgs.length;
    warn.className = 'alert' + (r && r.direct && r.direct.status === 'OVER' ? ' bad' : '');
    warn.textContent = msgs.join(' ');

    var list = visibleCourses(), cards = $('cards');
    if (!list.length) {
      cards.innerHTML = '<div class="empty">조건에 맞는 코스가 없어요. 남은 시간이나 출발/도착 건물을 바꿔보세요.</div>';
      $('detail').hidden = true;
      return;
    }
    $('resTitle').textContent = state.pinned && state.pinned.course ? '즐겨찾기 + 추천 코스' : '추천 코스 TOP ' + Math.min(3, r.courses.length);
    cards.innerHTML = list.map(function (c) {
      var chain = c.stopNames.map(function (n, i) { return i === 0 || i === c.stopNames.length - 1 ? '<b>' + esc(n) + '</b>' : esc(n); }).join(' → ');
      var fav = isFav(c), ph = coursePhoto(c);
      return '<article class="course' + (c.key === state.selectedKey ? ' sel' : '') + '" data-key="' + esc(c.key) + '" tabindex="0" aria-label="' + esc(c.title) + '">' +
        '<div class="thumb">' + imgTag(ph, 'thumb-img') + '<span class="rank' + (c.rank === '★' ? ' fav' : '') + '">' + c.rank + '</span>' +
        '<span class="chip ' + STATUS_CHIP[c.status] + ' thumb-status">' + c.statusLabel + '</span>' +
        '<button type="button" class="star" data-act="fav" aria-pressed="' + fav + '" title="즐겨찾기" aria-label="즐겨찾기">' + (fav ? '★' : '☆') + '</button></div>' +
        '<h3>' + esc(c.title) + '</h3>' +
        '<div class="chain">' + chain + '</div>' +
        '<div class="metrics">' +
          '<div><small>거리</small><strong>' + fmtDist(c.lengthM) + '</strong></div>' +
          '<div><small>소요</small><strong>' + fmtMin(c.totalMin) + '</strong></div>' +
          '<div><small>여유</small><strong class="' + (c.slackMin < 0 ? 'neg' : '') + '">' + fmtMin(c.slackMin) + '</strong></div>' +
          '<div><small>적합도</small><strong>' + c.displayScore + '</strong></div>' +
        '</div>' +
        '<div class="tags">' + c.reasons.map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') + '</div>' +
        '<div class="row"><button type="button" class="btn small" data-act="view">지도에서 보기</button>' +
        '<button type="button" class="btn small primary" data-act="start"' + (c.status === 'OVER' ? ' title="지각 위험 코스입니다"' : '') + '>산책 시작</button></div>' +
        '</article>';
    }).join('');
    renderDetail();
  }

  function renderDetail() {
    var c = selectedCourse(), el = $('detail');
    if (!c) { el.hidden = true; return; }
    el.hidden = false;
    var avail = c.availableMin, t0 = now();
    var w = function (v) { return Math.max(0, v / Math.max(avail, c.requiredMin) * 100).toFixed(1) + '%'; };
    var budget = '<i class="b-walk" style="width:' + w(c.walkMin) + '" title="걷기"></i>' +
      '<i class="b-dwell" style="width:' + w(c.dwellMin) + '" title="경유 휴식"></i>' +
      '<i class="b-buf" style="width:' + w(c.bufferMin) + '" title="수업 준비 버퍼"></i>' +
      (c.slackMin >= 0 ? '<i class="b-slack" style="width:' + w(c.slackMin) + '" title="여유"></i>' : '');
    var tcur = t0.getTime(), steps = [];
    steps.push('<li><span class="t">' + hm(t0) + '</span><span class="start">출발 · ' + esc(nodeName(c.start)) + '</span><span class="m"></span></li>');
    c.steps.forEach(function (s) {
      tcur += s.minutes * 60000;
      var feat = (s.features || []).map(function (f) { return '<span class="chip feat-' + f + '">' + esc(D.FEATURES[f].label) + '</span>'; }).join('');
      steps.push('<li><span class="t">' + hm(new Date(tcur)) + '</span>' +
        (s.kind === 'stop' ? '<span class="stop">' + esc(s.text) + '</span><span class="m">' + s.minutes + '분 휴식</span>'
          : '<span>' + esc(s.text.replace(/, (벚꽃길|단풍길|야간 조명 코스)/g, '')) + ' ' + feat + '</span><span class="m">' + fmtDist(s.lengthM) + ' · ' + Math.max(1, Math.round(s.minutes)) + '분</span>') + '</li>');
    });
    var classAt = new Date(t0.getTime() + avail * 60000);
    steps.push('<li><span class="t">' + hm(classAt) + '</span><span class="end">수업 시작 · ' + esc(nodeName(c.end)) + '</span><span class="m">버퍼 ' + c.bufferMin + '분 포함</span></li>');
    var returnAt = new Date(t0.getTime() + c.returnDepartOffsetMin * 60000);
    var bd = c.breakdown, bdTxt = [
      '날씨·시간대-경로 ' + bd.weatherRoute, '상황-스팟 ' + bd.contextSpots, '계절·야간 특화 구간 ' + bd.features, '테마-스팟 ' + bd.themeSpots,
      '테마-경로 ' + bd.themeRoute, '시간 활용 ' + bd.utilization, '장거리 ' + bd.longWalk, '중복 구간 ' + bd.repeat, '복잡도 ' + bd.complexity, '판정 ' + bd.status
    ].join(' · ');
    el.innerHTML = '<div class="card-h"><h2>' + esc(c.title) + ' — 단계별 안내</h2><span class="chip ' + STATUS_CHIP[c.status] + '">' +
      c.statusLabel + ' (' + (c.slackMin >= 0 ? '+' : '') + c.slackMin + '분)</span></div>' +
      '<div class="budget" aria-label="시간 예산">' + budget + '</div>' +
      '<div class="budget-legend"><span><i class="b-walk"></i>걷기 ' + fmtMin(c.walkMin) + '</span><span><i class="b-dwell"></i>휴식 ' + c.dwellMin + '분</span>' +
      '<span><i class="b-buf"></i>버퍼 ' + c.bufferMin + '분</span><span><i class="b-slack"></i>여유 ' + fmtMin(Math.max(0, c.slackMin)) + '</span>' +
      '<span>· 남은 시간 ' + fmtMin(avail) + '</span></div>' +
      '<p class="hint">복귀 출발 권장 시각: <b>' + hm(returnAt) + '</b> — ' + esc(nodeName(c.returnFrom)) + '에서 ' + esc(nodeName(c.end)) +
      '(으)로 출발하세요 (복귀 구간 ' + fmtMin(c.returnLegMin) + ').</p>' +
      '<ol class="steps">' + steps.join('') + '</ol>' +
      '<details class="score-bd"><summary>점수 근거 보기 (내부 점수 ' + c.score + ')</summary>' + bdTxt +
      '<br>그늘 ' + Math.round(c.ratios.shade * 100) + '% · 건물 인접 ' + Math.round(c.ratios.covered * 100) + '% · 수변 ' + Math.round(c.ratios.water * 100) +
      '% · 숲길 ' + Math.round(c.ratios.forest * 100) + '% · 야간 조명 ' + Math.round(c.ratios.lit * 100) + '% · 오르막/계단 ' + Math.round(c.hillRatio * 100) + '%' +
      (state.result ? '<br>후보 ' + state.result.candidatesEvaluated + '개 평가 · 시간 내 가능 ' + state.result.feasibleCount + '개' : '') + '</details>';
  }

  function toggleFavorite(c) {
    var k = favKey(c), idx = -1;
    state.favorites.forEach(function (f, i) { if (favKey(f) === k) idx = i; });
    if (idx >= 0) { state.favorites.splice(idx, 1); toast('즐겨찾기에서 뺐어요'); }
    else {
      state.favorites.unshift({ id: T.uid(), title: c.title, start: c.start, end: c.end, spots: c.spots.slice(), lengthM: c.lengthM, savedAt: new Date().toISOString() });
      toast('즐겨찾기에 저장했어요');
    }
    store.set(KEYS.favorites, state.favorites);
    renderResults(); renderHistory();
  }

  /* =========================================================
   * 상황별 실사 포토 프리뷰 (히어로 + 갤러리 + 라이트박스)
   * ========================================================= */
  var SEASON_ICON = { spring: '봄', summer: '여름', autumn: '가을', winter: '겨울' };

  function renderHero() {
    if (!state.ctx) return;
    var c = selectedCourse();
    // 우선순위: 지도에서 고른 스팟 > 사용자가 고른 코스 > 현재 상황(계절·날씨·시간대) 대표 사진
    var useCourse = c && state.userPicked;
    var q = state.focusSpot ? photoQuery({ focus: state.focusSpot }) : (useCourse ? photoQuery({ stops: c.stops }) : photoQuery());
    var res = M.selectContextualPhoto(assign(q, { limit: 8 }));
    var hero = state.heroPick || res.hero;
    if (!hero) return;
    var img = $('heroImg');
    var url = M.photoUrl(hero.file);
    if (img.getAttribute('src') !== url) {
      img.classList.add('loading');
      img.onload = function () { img.classList.remove('loading'); };
      img.onerror = function () { img.classList.remove('loading'); };
      img.setAttribute('src', url);
    }
    img.alt = hero.caption;
    var focusName = state.focusSpot ? nodeName(state.focusSpot) : (useCourse ? c.title : '지금, ' + state.ctx.seasonLabel + ' ' + state.ctx.timeLabel + '의 금오공대');
    $('heroTitle').textContent = state.heroPick ? hero.caption : focusName;
    $('heroCap').textContent = state.heroPick ? '갤러리에서 고른 사진 — 다시 누르면 상황 자동 선택으로 돌아가요' :
      hero.caption + (res.reason ? ' · 매칭: ' + res.reason : '');
    var cx = state.ctx;
    $('heroChips').innerHTML = '<span class="chip ' + SEASON_CHIP[cx.season] + '">' + SEASON_ICON[cx.season] + '</span>' +
      '<span class="chip ' + TIME_CHIP[cx.time] + '">' + cx.timeLabel + '</span>' +
      '<span class="chip">' + esc(state.weather.cls.label) + '</span>' +
      (hero.fountainActive === true ? '<span class="chip water">분수 가동</span>' : hero.fountainActive === false ? '<span class="chip">분수 정지</span>' : '');
    var gal = res.gallery.slice();
    if (state.heroPick && gal.indexOf(state.heroPick) < 0) gal.unshift(state.heroPick);
    $('gallery').innerHTML = gal.map(function (p) {
      return '<button type="button" class="g-item' + (p === hero ? ' on' : '') + '" data-photo="' + p.id + '" title="' + esc(p.caption) + '">' +
        imgTag(p, 'g-img') + '</button>';
    }).join('');
  }

  function photoById(id) { return PH.PHOTOS.filter(function (p) { return p.id === id; })[0]; }
  function openLightbox(p) {
    if (!p) return;
    $('lbImg').src = M.photoUrl(p.file); $('lbImg').alt = p.caption; $('lbCap').textContent = p.caption;
    $('lightbox').hidden = false;
  }

  /* =========================================================
   * 지도 오버레이 (SVG)
   * ========================================================= */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, parent, text) {
    var el = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
  }
  function P(id) { var n = state.engine.graph.nodes[id]; return { x: n.x / 100 * MAP_W, y: n.y / 100 * MAP_H }; }
  function getVar(name, def) {
    try { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || def; } catch (e) { return def; }
  }

  /** 현재 계절·시간대 특화 구간 하이라이트 (벚꽃길/단풍길/야간 조명 + 여름 분수대 + 야경 포인트) */
  function drawHighlights(course) {
    var g = $('gHighlight'); g.innerHTML = '';
    if (!state.ctx) return;
    var pf = currentProfile(), cx = state.ctx;
    var onRoute = {};
    (course ? course.featureEdges : []).forEach(function (id) { onRoute[id] = true; });
    var hl = state.engine.activeFeatureEdges(pf), used = {};
    hl.forEach(function (e) {
      var a = P(e.a), b = P(e.b);
      e.features.forEach(function (f) {
        used[f] = true;
        var color = D.FEATURES[f].color, strong = onRoute[e.id];
        svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color, 'stroke-width': strong ? 9 : 7, 'stroke-linecap': 'round',
          opacity: strong ? 0.75 : 0.45, filter: 'url(#glow)', class: 'hl-glow hl-' + f }, g);
        svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color, 'stroke-width': strong ? 2.6 : 1.6, 'stroke-linecap': 'round',
          'stroke-dasharray': f === 'nightLit' ? '1.5 3' : '4 2.5', opacity: 0.95 }, g);
      });
    });
    var extra = [];
    if (cx.season === 'summer') {
      var fp = P('fountain');
      svg('circle', { cx: fp.x, cy: fp.y, r: 9, fill: 'none', stroke: '#2a9df4', 'stroke-width': 2, class: 'pulse' }, g);
      extra.push('<span class="hl-chip" style="--c:#2a9df4">여름 분수대 가동</span>');
    }
    if (cx.time === 'night' || cx.time === 'sunset') {
      var gp = P('global');
      svg('circle', { cx: gp.x, cy: gp.y, r: 10, fill: '#ffdd00', opacity: 0.35, filter: 'url(#glow)' }, g);
      if (cx.time === 'sunset') {
        var sp = P('studentHall');
        svg('circle', { cx: sp.x, cy: sp.y, r: 11, fill: '#ff9a3c', opacity: 0.4, filter: 'url(#glow)' }, g);
        extra.push('<span class="hl-chip" style="--c:#ff9a3c">노을 소극장·북카페</span>');
      } else extra.push('<span class="hl-chip" style="--c:#ffdd00">글로벌관 야경</span>');
    }
    if (cx.season === 'winter') extra.push('<span class="hl-chip" style="--c:#7fb3e6">겨울 보온 코스: 본관-도서관-학생회관-kit라운지</span>');
    var tint = $('nightTint');
    tint.setAttribute('opacity', cx.time === 'night' ? 0.38 : cx.time === 'sunset' ? 0.16 : 0);
    tint.setAttribute('fill', cx.time === 'sunset' ? '#7a2e00' : '#06142e');
    $('hlLegend').innerHTML = Object.keys(used).map(function (f) {
      return '<span class="hl-chip" style="--c:' + D.FEATURES[f].color + '">' + D.FEATURES[f].label + '</span>';
    }).join('') + extra.join('');
  }

  function drawMap() {
    var g = $('gMarkers'); g.innerHTML = '';
    var net = $('gNet'); net.innerHTML = '';
    var graph = state.engine.graph, c = selectedCourse(), roleOf = {};
    if (c) {
      c.spots.forEach(function (id, i) { roleOf[id] = { role: 'spot', idx: i + 1 }; });
      roleOf[c.start] = { role: 'start' };
      roleOf[c.end] = c.end === c.start ? { role: 'startend' } : { role: 'end' };
    } else { roleOf[state.prefs.start] = { role: 'start' }; roleOf[state.prefs.end] = { role: 'end' }; }
    if (state.showNet || state.calib.on) {
      var typeColor = { road: '#7d8a83', path: '#1d7a4f', arcade: '#8b4fc0', forest: '#2f6b2b', lakeside: '#2a72ad', track: '#c4372d' };
      graph.edges.forEach(function (e) {
        var a = P(e.a), b = P(e.b);
        svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'net-edge', stroke: typeColor[e.type] || '#555',
          'stroke-dasharray': e.slope === 'flat' ? null : '3 2' }, net);
      });
    }
    var hasPhoto = {};
    PH.PHOTOS.forEach(function (p) { p.nodes.forEach(function (n) { hasPhoto[n] = true; }); });
    Object.keys(graph.nodes).forEach(function (id) {
      var n = graph.nodes[id], p = P(id), role = roleOf[id];
      if (n.junction && !state.calib.on) return;
      var gm = svg('g', { class: 'mk' + (state.focusSpot === id ? ' focus' : ''), 'data-id': id, tabindex: n.junction ? null : '0', role: 'button',
        'aria-label': (n.num ? n.num + '. ' : '') + n.name + (hasPhoto[id] ? ' (사진 있음)' : ''), transform: 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')' }, g);
      svg('title', {}, gm, (n.num ? n.num + '. ' : '') + n.name);
      if (n.junction) {
        svg('circle', { class: 'dot', r: 3, fill: '#fff', stroke: '#555', 'stroke-width': 1 }, gm);
        if (state.calib.selected === id) svg('circle', { r: 6, fill: 'none', stroke: '#e0a100', 'stroke-width': 2 }, gm);
        return;
      }
      var fill = '#ffffff', stroke = '#0f4f9a', txt = '#0f4f9a', r = 7, label = n.num ? String(n.num) : (n.badge || '•');
      if (n.minor) { fill = n.id === 'fountain' ? '#e3f1ff' : '#e6f3df'; stroke = n.id === 'fountain' ? '#1565c0' : '#2f6b2b'; txt = stroke; r = 6.5; }
      if (role) {
        if (role.role === 'start' || role.role === 'startend') { fill = getVar('--start', '#1d7a4f'); stroke = '#fff'; txt = '#fff'; r = 9; }
        else if (role.role === 'end') { fill = getVar('--end', '#c4372d'); stroke = '#fff'; txt = '#fff'; r = 9; }
        else if (role.role === 'spot') { fill = getVar('--spot', '#d0811c'); stroke = '#fff'; txt = '#fff'; r = 8.5; }
      }
      if (role || state.focusSpot === id) svg('circle', { r: r + 3.5, fill: state.focusSpot === id ? '#ffdd00' : fill, opacity: state.focusSpot === id ? 0.6 : 0.25 }, gm);
      svg('circle', { class: 'dot', r: r, fill: fill, stroke: stroke, 'stroke-width': 1.6, filter: 'url(#halo)' }, gm);
      svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': label.length > 1 ? 6.6 : 7.6, fill: txt, y: 0.3 }, gm, label);
      if (hasPhoto[id]) svg('circle', { cx: r * 0.75, cy: -r * 0.75, r: 2.4, fill: '#ffdd00', stroke: '#0f4f9a', 'stroke-width': 0.8, class: 'cam' }, gm);
      if (state.calib.selected === id) svg('circle', { r: r + 4, fill: 'none', stroke: '#e0a100', 'stroke-width': 2 }, gm);
    });
    drawLabels(roleOf);
  }

  function drawLabels(roleOf) {
    var gl = $('gLabels'); gl.innerHTML = '';
    var graph = state.engine.graph;
    Object.keys(graph.nodes).forEach(function (id) {
      var n = graph.nodes[id];
      if (n.junction && !state.calib.on) return;
      var role = roleOf[id];
      if (!state.showNames && !role && !state.calib.on && state.focusSpot !== id) return;
      var p = P(id);
      var prefix = role ? (role.role === 'start' ? '출발 ' : role.role === 'end' ? '도착 ' : role.role === 'startend' ? '출발·도착 ' : role.idx + ') ') : '';
      svg('text', { class: 'lbl-name', x: p.x + 10, y: p.y + 2.5, 'font-size': n.junction ? 5.5 : 7 }, gl, prefix + n.name);
    });
  }

  function drawRoute() {
    var gr = $('gRoute'); gr.innerHTML = '';
    var c = selectedCourse();
    drawHighlights(c);
    drawMap();
    if (!c) return;
    c.legs.forEach(function (leg, li) {
      var pts = leg.nodes.map(P);
      if (pts.length < 2) return;
      var color = LEG_COLORS[li % LEG_COLORS.length];
      var d = pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
      svg('polyline', { points: d, class: 'route-line', stroke: '#ffffff', 'stroke-width': 6.5, opacity: 0.85 }, gr);
      svg('polyline', { points: d, class: 'route-line route-anim', stroke: color, 'stroke-width': 3.4 }, gr);
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 14) continue;
        var ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        svg('path', { d: 'M -3.6 -3 L 3.4 0 L -3.6 3 Z', fill: color, stroke: '#fff', 'stroke-width': 0.9,
          transform: 'translate(' + ((a.x + b.x) / 2).toFixed(1) + ' ' + ((a.y + b.y) / 2).toFixed(1) + ') rotate(' + ang.toFixed(1) + ')' }, gr);
      }
    });
  }

  /* --- 마커 팝오버 (실사 사진 + 설명) --- */
  function showPop(id) {
    var n = state.engine.graph.nodes[id];
    if (!n || n.junction) return;
    var pop = $('pop');
    var photos = M.photosForNode(id, photoQuery());
    var spotNote = n.spot ? '<div class="hint">산책 스팟 · ' + esc(n.spot.note) + ' (' + n.spot.dwell + '분)' +
      (n.spot.seasons ? ' · ' + n.spot.seasons.map(function (s) { return C.SEASONS[s].label; }).join('/') + ' 추천' : '') +
      (n.spot.times ? ' · ' + n.spot.times.map(function (s) { return C.TIMES[s].label; }).join('/') + ' 추천' : '') + '</div>' : '';
    pop.innerHTML = '<button type="button" class="x" data-act="close" aria-label="닫기">×</button>' +
      (photos.length ? '<button type="button" class="pop-photo" data-act="zoom" data-photo="' + photos[0].id + '">' + imgTag(photos[0], 'pop-img') + '</button>' +
        '<p class="pop-cap">' + esc(photos[0].caption) + (photos.length > 1 ? ' <span class="muted">(+' + (photos.length - 1) + '장)</span>' : '') + '</p>' : '') +
      '<h3>' + (n.num ? n.num + '. ' : '') + esc(n.name) + '</h3>' +
      (n.desc ? '<p class="pop-desc">' + esc(n.desc) + '</p>' : '') +
      '<div class="tags">' + (n.tags || []).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') + '</div>' + spotNote +
      '<div class="row">' + (n.num ? '<button type="button" class="btn small" data-act="setStart" data-id="' + id + '">출발로</button>' +
        '<button type="button" class="btn small" data-act="setEnd" data-id="' + id + '">도착으로</button>' : '') +
        (photos.length ? '<button type="button" class="btn small ghost" data-act="hero" data-id="' + id + '">사진 크게</button>' : '') + '</div>';
    var card = pop.parentNode, mkEl = document.querySelector('#gMarkers .mk[data-id="' + id + '"]');
    pop.hidden = false;
    if ((window.innerWidth || 1024) < 640 || !mkEl) {
      pop.classList.add('sheet'); pop.style.left = ''; pop.style.top = ''; pop.style.bottom = '';
    } else {
      // 지도(overflow:hidden) 밖으로도 보이도록 지도 카드 기준으로 배치하고, 카드 가장자리 안쪽으로 맞춤
      pop.classList.remove('sheet');
      var cr = card.getBoundingClientRect(), mr = mkEl.getBoundingClientRect();
      var x = mr.left + mr.width / 2 - cr.left, y = mr.top + mr.height / 2 - cr.top, w = pop.offsetWidth || 250;
      pop.style.left = Math.max(8, Math.min(cr.width - w - 8, x - w / 2)) + 'px';
      if (y < cr.height / 2) { pop.style.top = (y + 14) + 'px'; pop.style.bottom = ''; }
      else { pop.style.top = ''; pop.style.bottom = (cr.height - y + 14) + 'px'; }
    }
    state.focusSpot = id; state.heroPick = null;
    renderHero(); drawRoute();
  }
  function hidePop() {
    $('pop').hidden = true;
    if (state.focusSpot) { state.focusSpot = null; renderHero(); drawRoute(); }
  }

  function applyZoom() {
    $('mapInner').style.setProperty('--zoom', state.zoom);
    $('zoomVal').textContent = Math.round(state.zoom * 100) + '%';
  }
  function centerOnRoute() {
    var c = selectedCourse(), sc = $('mapScroll');
    if (!c || state.zoom <= 1 || !sc) return;
    var xs = c.path.map(function (id) { return state.engine.graph.nodes[id].x; });
    var ys = c.path.map(function (id) { return state.engine.graph.nodes[id].y; });
    var cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2 / 100;
    var cy = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2 / (state.showLegend ? 100 : D.MAP.mapAreaBottom);
    var inner = $('mapInner');
    sc.scrollLeft = Math.max(0, cx * inner.offsetWidth - sc.clientWidth / 2);
    sc.scrollTop = Math.max(0, cy * inner.offsetHeight - sc.clientHeight / 2);
  }

  /* --- 좌표 보정 모드 --- */
  function svgPointFromEvent(ev) {
    var rect = $('overlay').getBoundingClientRect();
    return { x: Math.round((ev.clientX - rect.left) / rect.width * 10000) / 100, y: Math.round((ev.clientY - rect.top) / rect.height * 10000) / 100 };
  }
  function renderCalib() {
    $('calibPanel').hidden = !state.calib.on;
    $('mapInner').classList.toggle('calib-on', state.calib.on);
    $('toggleCalib').setAttribute('aria-pressed', String(state.calib.on));
    var sel = state.calib.selected;
    $('calibSel').textContent = sel ? nodeName(sel) + ' (' + sel + ') ' + JSON.stringify({ x: state.engine.graph.nodes[sel].x, y: state.engine.graph.nodes[sel].y }) : '없음';
  }

  /* =========================================================
   * 산책 타이머
   * ========================================================= */
  function startWalk(c) {
    if (c.status === 'OVER' && !window.confirm('지각 위험 코스입니다. 그래도 시작할까요?')) return;
    var t0 = now().getTime(), ph = coursePhoto(c);
    state.active = {
      key: c.key, title: c.title, start: c.start, end: c.end, spots: c.spots.slice(), stopNames: c.stopNames.slice(),
      startedAt: t0, classAt: t0 + c.availableMin * 60000, returnAt: t0 + c.returnDepartOffsetMin * 60000,
      bufferMin: c.bufferMin, plannedMin: c.totalMin, lengthM: c.lengthM, returnFrom: c.returnFrom,
      weather: state.weather.cls.label + ' · ' + state.ctx.seasonLabel + ' · ' + state.ctx.timeLabel,
      status: c.status, photo: ph ? ph.file : null
    };
    state.notifiedReturn = false;
    store.set(KEYS.active, state.active);
    state.timerFolded = false;
    renderTimer();
    toast('산책을 시작했어요. 복귀 출발 시각에 알려드릴게요');
  }

  function renderTimer() {
    var a = state.active, el = $('timer');
    document.body.classList.toggle('has-timer', !!a);
    if (!a) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('folded', state.timerFolded);
    $('tmFold').textContent = state.timerFolded ? '펼치기' : '접기';
    $('tmFold').setAttribute('aria-expanded', String(!state.timerFolded));
    var th = $('tmThumb');
    if (a.photo) { var u = M.photoUrl(a.photo); if (th.getAttribute('src') !== u) th.setAttribute('src', u); th.hidden = false; } else th.hidden = true;
    var t = now().getTime();
    var toClass = a.classAt - t, toReturn = a.returnAt - t, prepAt = a.classAt - a.bufferMin * 60000;
    var phase = t < a.returnAt ? 'walk' : (t < prepAt ? 'return' : 'late');
    el.classList.toggle('phase-return', phase === 'return');
    el.classList.toggle('phase-late', phase === 'late');
    $('tmTitle').textContent = a.title;
    $('tmChain').textContent = a.stopNames.join(' → ') + ' · ' + fmtDist(a.lengthM) + ' · 예상 ' + fmtMin(a.plannedMin);
    $('tmClass').textContent = fmtCountdown(toClass);
    $('tmClassAt').textContent = hm(new Date(a.classAt)) + ' 수업 시작 · ' + nodeName(a.end);
    $('tmReturn').textContent = hm(new Date(a.returnAt));
    $('tmReturnAt').textContent = toReturn > 0 ? fmtCountdown(toReturn) + ' 뒤 ' + nodeName(a.returnFrom) + '에서 출발' : '지금 ' + nodeName(a.returnFrom) + '에서 출발!';
    var total = a.classAt - a.startedAt;
    $('tmBar').style.width = Math.max(0, Math.min(100, (t - a.startedAt) / total * 100)) + '%';
    $('tmBar').style.background = phase === 'walk' ? 'var(--accent)' : phase === 'return' ? 'var(--warn)' : 'var(--bad)';
    $('tmReturnTick').style.left = Math.max(0, Math.min(100, (a.returnAt - a.startedAt) / total * 100)) + '%';
    var msg;
    if (phase === 'walk') msg = '산책 중 — 약 ' + fmtMin(Math.floor(toReturn / 60000)) + ' 뒤 ' + nodeName(a.returnFrom) + '에서 복귀를 시작하세요.';
    else if (phase === 'return') msg = '복귀 출발 시각이에요! 지금 ' + nodeName(a.end) + '(으)로 이동하세요.';
    else msg = toClass > 0 ? '수업 준비 버퍼 구간이에요. 서둘러 ' + nodeName(a.end) + '(으)로!' : '수업이 시작됐어요.';
    $('tmMsg').textContent = msg;
    if (phase !== 'walk' && !state.notifiedReturn) {
      state.notifiedReturn = true;
      try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* noop */ }
      toast('복귀 출발 시각이에요!');
    }
  }

  function finishWalk(record) {
    var a = state.active;
    if (!a) return;
    if (record) {
      state.history.unshift({
        id: T.uid(), date: new Date(a.startedAt).toISOString(), title: a.title, stops: a.stopNames,
        start: a.start, end: a.end, spots: a.spots, lengthM: a.lengthM, plannedMin: a.plannedMin,
        actualMin: Math.round((now().getTime() - a.startedAt) / 6000) / 10, weather: a.weather,
        onTime: now().getTime() <= a.classAt, photo: a.photo
      });
      state.history = state.history.slice(0, 200);
      store.set(KEYS.history, state.history);
      toast('산책 기록을 저장했어요');
    } else toast('산책을 중단했어요');
    state.active = null;
    store.del(KEYS.active);
    renderTimer(); renderHistory();
  }

  /* =========================================================
   * 시간표 화면
   * ========================================================= */
  function renderTimetable() {
    var d = now(), today = d.getDay(), nc = T.nextClass(state.timetable, d);
    var days = [1, 2, 3, 4, 5];
    if (state.timetable.some(function (e) { return Number(e.day) === 6 || Number(e.day) === 0; })) days.push(6, 0);
    var sorted = T.sortEntries(state.timetable);
    $('week').innerHTML = days.map(function (day) {
      var items = sorted.filter(function (e) { return Number(e.day) === day; });
      return '<div class="day' + (day === today ? ' today' : '') + '"><h3>' + T.DAY_LABELS[day] + (day === today ? ' (오늘)' : '') + '</h3>' +
        (items.length ? items.map(function (e) {
          var isNext = nc.next && nc.next.id === e.id;
          return '<div class="cls' + (isNext ? ' next' : '') + '"><b>' + esc(e.title || '(제목 없음)') + '</b>' +
            esc(e.start) + '–' + esc(e.end) + ' · ' + esc(nodeName(e.building)) + (isNext ? ' <span class="chip bad">다음 수업</span>' : '') +
            '<div class="row"><button type="button" class="btn small ghost" data-act="edit" data-id="' + esc(e.id) + '">수정</button>' +
            '<button type="button" class="btn small ghost danger" data-act="del" data-id="' + esc(e.id) + '">삭제</button></div></div>';
        }).join('') : '<p class="hint">수업 없음</p>') + '</div>';
    }).join('');
    var nb = $('nextBox');
    if (nc.next) nb.innerHTML = '<b>' + nc.dayLabel + ' ' + hm(d) + ' 기준</b> 다음 수업: ' + esc(nc.next.title) + ' (' + esc(nc.next.start) + ', ' + esc(nodeName(nc.next.building)) +
      ') — <b>' + fmtMin(nc.minutesUntil) + '</b> 남음' + (nc.fromBuilding ? '<br>현재 위치 추정: ' + esc(nodeName(nc.fromBuilding)) : '');
    else nb.innerHTML = '<b>' + nc.dayLabel + ' ' + hm(d) + ' 기준</b> 오늘 남은 수업이 없어요.' + (nc.current ? ' (지금 ' + esc(nc.current.title) + ' 수업 중)' : '');
    $('clockMode').hidden = !state.clockOffset;
  }
  function resetTtForm() {
    $('ttId').value = ''; $('ttTitle').value = ''; $('ttErr').textContent = '';
    $('ttSubmit').textContent = '추가'; $('ttFormTitle').textContent = '수업 추가'; $('ttCancel').hidden = true;
  }
  function saveTimetable() { store.set(KEYS.timetable, state.timetable); renderTimetable(); }

  /* =========================================================
   * 기록·즐겨찾기 화면
   * ========================================================= */
  function renderHistory() {
    var h = state.history;
    var dist = h.reduce(function (s, x) { return s + (x.lengthM || 0); }, 0);
    var mins = h.reduce(function (s, x) { return s + (x.actualMin || 0); }, 0);
    $('stats').innerHTML = '<div class="stat"><strong>' + h.length + '</strong><span>산책 횟수</span></div>' +
      '<div class="stat"><strong>' + fmtDist(dist) + '</strong><span>누적 거리</span></div>' +
      '<div class="stat"><strong>' + fmtMin(mins) + '</strong><span>누적 시간</span></div>';
    $('histList').innerHTML = h.length ? h.map(function (x) {
      var d = new Date(x.date);
      var ph = x.photo ? PH.PHOTOS.filter(function (p) { return p.file === x.photo; })[0] : null;
      return '<li>' + (ph ? imgTag(ph, 'list-thumb') : '') + '<div class="grow"><b>' + esc(x.title) + '</b><div class="meta">' + (d.getMonth() + 1) + '/' + d.getDate() + '(' + T.DAY_LABELS[d.getDay()] + ') ' + hm(d) +
        ' · ' + esc((x.stops || []).join(' → ')) + '</div><div class="meta">' + fmtDist(x.lengthM) + ' · 예상 ' + fmtMin(x.plannedMin) + ' / 실제 ' + fmtMin(x.actualMin) +
        ' · ' + esc(x.weather) + (x.onTime === false ? ' · <span class="chip bad">지각</span>' : '') + '</div></div>' +
        '<button type="button" class="btn small ghost danger" data-act="delHist" data-id="' + esc(x.id) + '">삭제</button></li>';
    }).join('') : '<li class="hint">아직 산책 기록이 없어요. 코스를 고르고 [산책 시작]을 눌러보세요.</li>';
    $('favList').innerHTML = state.favorites.length ? state.favorites.map(function (f) {
      var chain = [f.start].concat(f.spots, [f.end]).map(nodeName).join(' → ');
      var ph = state.ctx ? M.selectContextualPhoto(photoQuery({ stops: [f.start].concat(f.spots, [f.end]) })).hero : null;
      return '<li>' + (ph ? imgTag(ph, 'list-thumb') : '') + '<div class="grow"><b>' + esc(f.title) + '</b><div class="meta">' + esc(chain) + ' · ' + fmtDist(f.lengthM || 0) + '</div></div>' +
        '<div class="row"><button type="button" class="btn small" data-act="loadFav" data-id="' + esc(f.id) + '">불러오기</button>' +
        '<button type="button" class="btn small ghost danger" data-act="delFav" data-id="' + esc(f.id) + '">삭제</button></div></li>';
    }).join('') : '<li class="hint">추천 카드의 ☆를 눌러 코스를 저장하세요.</li>';
  }

  /* =========================================================
   * 탭 / 시계
   * ========================================================= */
  function setTab(tab) {
    state.tab = tab;
    ['plan', 'timetable', 'history'].forEach(function (t) { $('v-' + t).hidden = t !== tab; });
    Array.prototype.forEach.call(document.querySelectorAll('.tab[data-tab]'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab));
    });
    if (tab === 'timetable') renderTimetable();
    if (tab === 'history') renderHistory();
    if (location.hash !== '#' + tab) { try { history.replaceState(null, '', location.pathname + location.search + '#' + tab); } catch (e) { /* file:// 등 */ } }
  }
  function tick() {
    var d = now();
    $('clockTime').textContent = hm(d) + ':' + pad(d.getSeconds());
    $('clockDay').textContent = (d.getMonth() + 1) + '/' + d.getDate() + '(' + T.DAY_LABELS[d.getDay()] + ')';
    $('clockMode').hidden = !state.clockOffset;
    if (state.active) renderTimer();
    var minuteKey = d.getHours() * 60 + d.getMinutes();
    if (state.lastMinute != null && minuteKey !== state.lastMinute) {
      // 1분마다: 자동 계절/시간대 재판별(노을→야간 전환 등) + 시간표 연동 갱신
      var before = state.ctx && state.ctx.season + state.ctx.time;
      updateContext();
      if (state.autoLinked) autofillFromTimetable(true);
      else if (before !== state.ctx.season + state.ctx.time) { renderWeather(); recompute(); }
    }
    state.lastMinute = minuteKey;
  }
  function contextChanged() { updateContext(); renderWeather(); state.heroPick = null; state.userPicked = false; recompute(); }

  /* =========================================================
   * 이벤트 바인딩
   * ========================================================= */
  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab[data-tab]'), function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
    });
    $('introReplay').addEventListener('click', function () { intro.play(); });
    // 조건 폼
    $('start').addEventListener('change', function () { state.prefs.start = this.value; state.pinned = null; state.autoLinked = false; savePrefs(); recompute(); });
    $('end').addEventListener('change', function () { state.prefs.end = this.value; state.pinned = null; state.autoLinked = false; savePrefs(); recompute(); });
    $('swap').addEventListener('click', function () {
      var p = state.prefs, t = p.start; p.start = p.end; p.end = t; state.autoLinked = false;
      $('start').value = p.start; $('end').value = p.end; state.pinned = null; savePrefs(); recompute();
    });
    $('avail').addEventListener('input', function () { state.autoLinked = false; setAvail(this.value); });
    $('availPresets').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-min]'); if (b) { state.autoLinked = false; setAvail(b.getAttribute('data-min')); }
    });
    $('speedSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-v]'); if (!b) return;
      state.prefs.speed = b.getAttribute('data-v'); savePrefs(); writeSegs(); recompute();
    });
    $('themeChips').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-v]'); if (!b) return;
      state.prefs.theme = b.getAttribute('data-v'); savePrefs(); writeSegs(); recompute();
    });
    $('buffer').addEventListener('change', function () { state.prefs.buffer = Number(this.value); savePrefs(); recompute(); });
    $('autofill').addEventListener('click', function () { autofillFromTimetable(false); });
    $('go').addEventListener('click', function () {
      recompute();
      var r = $('results'); if (r.scrollIntoView) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // 상황 시뮬레이터
    $('wxModeSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-v]'); if (!b) return;
      state.prefs.weatherMode = b.getAttribute('data-v'); savePrefs();
      if (state.prefs.weatherMode === 'live') state.weather.obs = null;
      state.heroPick = null; state.userPicked = false;
      loadWeather();
    });
    $('seasonSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-v]'); if (!b) return;
      state.prefs.seasonMode = b.getAttribute('data-v'); savePrefs(); contextChanged();
    });
    $('timeSeg').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-v]'); if (!b) return;
      state.prefs.timeMode = b.getAttribute('data-v'); savePrefs(); contextChanged();
    });
    $('simReset').addEventListener('click', function () {
      state.prefs.seasonMode = 'auto'; state.prefs.timeMode = 'auto';
      var wasLive = state.prefs.weatherMode === 'live';
      state.prefs.weatherMode = 'live'; savePrefs();
      if (!wasLive) state.weather.obs = null;
      state.heroPick = null;
      loadWeather();
      toast('실시간 날씨·현재 계절·시간대로 돌아왔어요');
    });
    $('wxRefresh').addEventListener('click', function () {
      if (state.prefs.weatherMode !== 'live') { state.prefs.weatherMode = 'live'; savePrefs(); state.weather.obs = null; }
      loadWeather();
    });
    // 히어로 / 갤러리 / 라이트박스
    $('gallery').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-photo]'); if (!b) return;
      var p = photoById(b.getAttribute('data-photo'));
      state.heroPick = state.heroPick === p ? null : p;
      renderHero();
    });
    $('heroImg').addEventListener('click', function () {
      var src = $('heroImg').getAttribute('src');
      openLightbox(PH.PHOTOS.filter(function (p) { return M.photoUrl(p.file) === src; })[0]);
    });
    $('lbClose').addEventListener('click', function () { $('lightbox').hidden = true; });
    $('lightbox').addEventListener('click', function (ev) { if (ev.target.id === 'lightbox') $('lightbox').hidden = true; });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { $('lightbox').hidden = true; } });
    // 결과 카드
    $('cards').addEventListener('click', function (ev) {
      var card = ev.target.closest('.course'); if (!card) return;
      var key = card.getAttribute('data-key');
      var c = visibleCourses().filter(function (x) { return x.key === key; })[0];
      if (!c) return;
      var act = ev.target.closest('[data-act]');
      act = act && act.getAttribute('data-act');
      if (act === 'fav') { toggleFavorite(c); return; }
      state.selectedKey = key; state.focusSpot = null; state.heroPick = null; state.userPicked = true; $('pop').hidden = true;
      renderResults(); drawRoute(); renderHero();
      if (act === 'start') { startWalk(c); return; }
      if (act === 'view') { var m = $('mapScroll'); centerOnRoute(); if (m.scrollIntoView) m.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    $('cards').addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var card = ev.target.closest('.course');
      if (card && ev.target === card) { ev.preventDefault(); state.selectedKey = card.getAttribute('data-key'); state.focusSpot = null; renderResults(); drawRoute(); renderHero(); }
    });
    // 지도
    $('zoomIn').addEventListener('click', function () { state.zoom = Math.min(3, Math.round((state.zoom + 0.4) * 10) / 10); applyZoom(); centerOnRoute(); });
    $('zoomOut').addEventListener('click', function () { state.zoom = Math.max(1, Math.round((state.zoom - 0.4) * 10) / 10); applyZoom(); centerOnRoute(); });
    $('toggleNames').addEventListener('click', function () { state.showNames = !state.showNames; this.setAttribute('aria-pressed', String(state.showNames)); drawRoute(); });
    $('toggleNet').addEventListener('click', function () { state.showNet = !state.showNet; this.setAttribute('aria-pressed', String(state.showNet)); drawRoute(); });
    $('toggleLegend').addEventListener('click', function () {
      state.showLegend = !state.showLegend; this.setAttribute('aria-pressed', String(state.showLegend));
      $('mapInner').classList.toggle('legend-on', state.showLegend); hidePop();
    });
    $('toggleCalib').addEventListener('click', function () {
      state.calib.on = !state.calib.on; state.calib.selected = null; hidePop(); renderCalib(); drawRoute();
    });
    var overlay = $('overlay');
    overlay.addEventListener('click', function (ev) {
      var mk = ev.target.closest && ev.target.closest('.mk');
      if (state.calib.on) {
        if (mk) { state.calib.selected = mk.getAttribute('data-id'); renderCalib(); drawRoute(); return; }
        if (state.calib.selected) {
          var pt = svgPointFromEvent(ev);
          state.overrides[state.calib.selected] = pt;
          store.set(KEYS.coords, state.overrides);
          rebuildEngine(); recompute(); renderCalib();
          toast(nodeName(state.calib.selected) + ' → x ' + pt.x + '%, y ' + pt.y + '%');
        }
        return;
      }
      if (mk) showPop(mk.getAttribute('data-id')); else hidePop();
    });
    overlay.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var mk = ev.target.closest && ev.target.closest('.mk');
      if (mk) { ev.preventDefault(); showPop(mk.getAttribute('data-id')); }
    });
    overlay.addEventListener('mousemove', function (ev) {
      if (!state.calib.on) return;
      var pt = svgPointFromEvent(ev);
      $('calibCursor').textContent = 'x ' + pt.x.toFixed(2) + '%, y ' + pt.y.toFixed(2) + '%';
    });
    $('pop').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]'); if (!b) return;
      var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
      if (act === 'zoom') { openLightbox(photoById(b.getAttribute('data-photo'))); return; }
      if (act === 'hero') { var h = $('hero'); if (h.scrollIntoView) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (act === 'setStart') { state.prefs.start = id; $('start').value = id; }
      if (act === 'setEnd') { state.prefs.end = id; $('end').value = id; }
      if (act !== 'close') { state.pinned = null; state.autoLinked = false; savePrefs(); recompute(); toast((act === 'setStart' ? '출발: ' : '도착: ') + nodeName(id)); }
      hidePop();
    });
    $('calibCopy').addEventListener('click', function () {
      var out = {};
      Object.keys(state.engine.graph.nodes).forEach(function (id) { var n = state.engine.graph.nodes[id]; out[id] = { x: n.x, y: n.y }; });
      var json = JSON.stringify({ overrides: state.overrides, all: out }, null, 1);
      var ta = $('calibOut'); ta.hidden = false; ta.value = json;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(function () { toast('좌표 JSON을 복사했어요'); }, function () { ta.select(); toast('아래 텍스트를 복사하세요'); });
      } else { ta.select(); toast('아래 텍스트를 복사하세요'); }
    });
    $('calibReset').addEventListener('click', function () {
      state.overrides = {}; store.del(KEYS.coords); state.calib.selected = null;
      rebuildEngine(); recompute(); renderCalib(); toast('보정값을 초기화했어요');
    });
    // 타이머
    $('tmDone').addEventListener('click', function () { finishWalk(true); });
    $('tmStop').addEventListener('click', function () { finishWalk(false); });
    $('tmFold').addEventListener('click', function () { state.timerFolded = !state.timerFolded; renderTimer(); });
    // 시간표
    $('ttDay').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(function (d) { return '<option value="' + d + '">' + T.DAY_LABELS[d] + '요일</option>'; }).join('');
    $('ttDay').value = String(now().getDay() >= 1 && now().getDay() <= 5 ? now().getDay() : 1);
    $('ttBuilding').innerHTML = buildingOptions('digital');
    $('ttForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var entry = {
        id: $('ttId').value || T.uid(), day: Number($('ttDay').value), start: $('ttStart').value, end: $('ttEnd').value,
        title: $('ttTitle').value.trim() || '수업', building: $('ttBuilding').value
      };
      var err = T.validateEntry(entry, D.LANDMARKS.map(function (n) { return n.id; }));
      if (!err && T.overlaps(state.timetable, entry).length) err = '같은 요일에 시간이 겹치는 수업이 있어요.';
      $('ttErr').textContent = err || '';
      if (err) return;
      var idx = -1;
      state.timetable.forEach(function (e, i) { if (e.id === entry.id) idx = i; });
      if (idx >= 0) state.timetable[idx] = entry; else state.timetable.push(entry);
      saveTimetable(); resetTtForm();
      toast(idx >= 0 ? '수업을 수정했어요' : '수업을 추가했어요');
    });
    $('ttCancel').addEventListener('click', resetTtForm);
    $('week').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]'); if (!b) return;
      var id = b.getAttribute('data-id');
      var e = state.timetable.filter(function (x) { return x.id === id; })[0];
      if (!e) return;
      if (b.getAttribute('data-act') === 'del') {
        state.timetable = state.timetable.filter(function (x) { return x.id !== id; });
        saveTimetable(); toast('삭제했어요');
      } else {
        $('ttId').value = e.id; $('ttDay').value = String(e.day); $('ttStart').value = e.start; $('ttEnd').value = e.end;
        $('ttTitle').value = e.title; $('ttBuilding').value = e.building;
        $('ttSubmit').textContent = '수정 저장'; $('ttFormTitle').textContent = '수업 수정'; $('ttCancel').hidden = false;
        $('ttTitle').focus();
      }
    });
    $('ttSample').addEventListener('click', function () {
      if (state.timetable.length && !window.confirm('현재 시간표를 예시 시간표로 바꿀까요?')) return;
      state.timetable = T.sampleTimetable(); saveTimetable(); toast('예시 시간표를 불러왔어요');
    });
    $('ttClear').addEventListener('click', function () {
      if (!state.timetable.length || !window.confirm('시간표를 모두 지울까요?')) return;
      state.timetable = []; saveTimetable();
    });
    $('testApply').addEventListener('click', function () {
      var v = $('testTime').value, d = v ? new Date(v) : null;
      if (!d || isNaN(d.getTime())) { toast('테스트 시각을 입력하세요'); return; }
      state.clockOffset = d.getTime() - Date.now();
      store.set(KEYS.clock, state.clockOffset);
      tick(); renderTimetable(); contextChanged(); toast('테스트 시각을 적용했어요');
      autofillFromTimetable(true);
    });
    $('testClear').addEventListener('click', function () {
      state.clockOffset = 0; store.del(KEYS.clock); tick(); renderTimetable(); contextChanged(); toast('실제 시각으로 돌아왔어요');
      autofillFromTimetable(true);
    });
    // 기록·즐겨찾기
    $('histList').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act="delHist"]'); if (!b) return;
      var id = b.getAttribute('data-id');
      state.history = state.history.filter(function (x) { return x.id !== id; });
      store.set(KEYS.history, state.history); renderHistory();
    });
    $('histClear').addEventListener('click', function () {
      if (!state.history.length || !window.confirm('산책 기록을 모두 지울까요?')) return;
      state.history = []; store.set(KEYS.history, state.history); renderHistory();
    });
    $('favList').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]'); if (!b) return;
      var id = b.getAttribute('data-id');
      var f = state.favorites.filter(function (x) { return x.id === id; })[0];
      if (!f) return;
      if (b.getAttribute('data-act') === 'delFav') {
        state.favorites = state.favorites.filter(function (x) { return x.id !== id; });
        store.set(KEYS.favorites, state.favorites); renderHistory(); renderResults(); return;
      }
      state.prefs.start = f.start; state.prefs.end = f.end;
      $('start').value = f.start; $('end').value = f.end; savePrefs();
      state.pinned = { title: f.title, spots: f.spots.slice() };
      setTab('plan'); recompute();
      state.selectedKey = state.pinned.course ? state.pinned.course.key : state.selectedKey;
      renderResults(); drawRoute(); renderHero();
      toast('즐겨찾기 코스를 지금 상황으로 다시 계산했어요');
    });
    window.addEventListener('hashchange', function () {
      var t = location.hash.replace('#', '');
      if (['plan', 'timetable', 'history'].indexOf(t) >= 0 && t !== state.tab) setTab(t);
    });
    window.addEventListener('online', function () { if (state.prefs.weatherMode === 'live') loadWeather(); });
  }

  /* =========================================================
   * 시작
   * ========================================================= */
  function init() {
    var ids = D.LANDMARKS.map(function (n) { return n.id; });
    if (ids.indexOf(state.prefs.start) < 0) state.prefs.start = DEFAULT_PREFS.start;
    if (ids.indexOf(state.prefs.end) < 0) state.prefs.end = DEFAULT_PREFS.end;
    if (!E.SPEEDS[state.prefs.speed]) state.prefs.speed = 'normal';
    if (!D.THEMES.some(function (t) { return t.id === state.prefs.theme; })) state.prefs.theme = 'auto';
    if (!WEATHER_MODES.some(function (m) { return m.id === state.prefs.weatherMode; })) state.prefs.weatherMode = 'live';
    if (!SEASON_MODES.some(function (m) { return m.id === state.prefs.seasonMode; })) state.prefs.seasonMode = 'auto';
    if (!TIME_MODES.some(function (m) { return m.id === state.prefs.timeMode; })) state.prefs.timeMode = 'auto';
    if ([3, 5, 10].indexOf(Number(state.prefs.buffer)) < 0) state.prefs.buffer = 5;
    if (state.active && (!state.active.classAt || now().getTime() > state.active.classAt + 30 * 60000)) { state.active = null; store.del(KEYS.active); }

    rebuildEngine();
    updateContext();
    writeForm();
    bind();
    applyZoom();
    renderCalib();
    var banners = [];
    if (!store.persistent) banners.push('이 브라우저에서는 저장소를 쓸 수 없어 시간표·기록이 새로고침 시 초기화됩니다.');
    if (Object.keys(state.overrides).length) banners.push('좌표 보정값 ' + Object.keys(state.overrides).length + '개가 적용되어 있어요. (지도 > 좌표 보정 > 초기화로 되돌릴 수 있어요)');
    if (banners.length) { $('banner').hidden = false; $('banner').textContent = banners.join(' '); }
    $('mapImg').addEventListener('error', function () {
      var bn = $('banner'); bn.hidden = false;
      bn.textContent = '캠퍼스맵 이미지를 불러오지 못했어요. kumoh_ac_kr_20120125_164421.jpg 파일이 index.html과 같은 폴더에 있는지 확인하세요.';
    });
    var hash = location.hash.replace('#', '');
    setTab(['plan', 'timetable', 'history'].indexOf(hash) >= 0 ? hash : 'plan');
    tick();
    setInterval(tick, 1000);
    autofillFromTimetable(true);
    loadWeather(); // 내부에서 recompute + 히어로 갱신
    centerOnRoute();
    renderTimer();
    renderHistory();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.KITWalkApp = { state: state, recompute: recompute, loadWeather: loadWeather, autofill: autofillFromTimetable, intro: intro };
})();
