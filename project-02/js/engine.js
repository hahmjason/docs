/*
 * KIT 공강 산책 — 처리 계층(추천·경로 계산 엔진)
 * ------------------------------------------------------------
 *  1) 캠퍼스 도보 그래프 구성 (노드: 21개 지점 + 도서관 앞 분수대·숲길 쉼터 + 교차점, 엣지: 보행 연결로)
 *  2) 날씨 × 계절 × 시간대 프로필을 합성해 가중 비용으로 다익스트라 최단 경로 탐색
 *  3) [출발] → (산책 경유 스팟 0~3곳) → [다음 수업 건물] 후보 코스 생성
 *  4) 걷기 속도·오르막·날씨/야간 보정 소요 시간 + 수업 준비 버퍼로 SAFE/TIGHT/OVER 판정
 *  5) 날씨·계절·시간대·테마·시간 활용도 점수로 TOP N 추천
 * 순수 함수 위주이며 DOM에 의존하지 않아 Node 테스트에서도 그대로 실행됩니다.
 */
(function (root, factory) {
  var data = root && root.KITWalkData;
  if (!data && typeof require === 'function') data = require('../data/campus-data.js');
  var api = factory(data);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KITWalkEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DEFAULT_DATA) {
  'use strict';

  /* ---------- 상수 ---------- */
  var SPEEDS = {
    slow:   { id: 'slow',   label: '느긋하게', mpm: 55 }, // 약 3.3km/h
    normal: { id: 'normal', label: '보통',     mpm: 70 }, // 약 4.2km/h
    fast:   { id: 'fast',   label: '빠르게',   mpm: 85 }  // 약 5.1km/h
  };
  var SLOPE = {
    flat:   { label: '평지',   factor: 1.0 },
    hill:   { label: '오르막', factor: 1.2 },
    stairs: { label: '계단',   factor: 1.3 }
  };
  var STATUS = {
    SAFE:  { id: 'SAFE',  label: '여유' },
    TIGHT: { id: 'TIGHT', label: '빠듯함' },
    OVER:  { id: 'OVER',  label: '지각 위험' }
  };
  var DEFAULT_BUFFER_MIN = 5;
  var TIGHT_MARGIN_MIN = 3;
  var TARGET_UTILIZATION = 0.75;
  var FEATURE_FULL_M = 150; // 특화 구간을 이 길이 이상 걸으면 가산점 100%

  /*
   * 날씨 프로필 — env: 구간 환경 가중치, spot: 경유 스팟 태그 가중치
   *  excludeUnpaved: 흙길·트랙 제외, excludeFields: 운동장류 스팟 제외, longWalk: 장거리 감점, slopeExtra: 오르막 추가 계수
   */
  var WEATHER_PROFILES = {
    clear: {
      label: '맑음·선선함', speedFactor: 1.0, excludeUnpaved: false, excludeFields: false, slopeExtra: 0,
      env: { open: 1, shade: 0.5, covered: -0.5, water: 3, forest: 2.5, unpaved: 0 },
      spot: { water: 6, view: 4, forest: 5, open: 2, sport: 1, cafe: 1, indoor: -1 },
      longWalk: { thresholdM: 2500, per100m: 0.2 },
      tips: ['야외 경관 코스를 즐기기 좋은 날씨예요.']
    },
    rain: {
      label: '비', speedFactor: 1.1, excludeUnpaved: true, excludeFields: true, slopeExtra: 0.05,
      env: { open: -3, shade: 0.5, covered: 3.5, water: -1.5, forest: 0, unpaved: -4 },
      spot: { indoor: 6, cafe: 5, food: 2, rest: 2, quiet: 1, theater: 2, water: -6, view: -3, open: -5, sport: -3, forest: -5, cherry: -4, fountain: -4 },
      longWalk: { thresholdM: 500, per100m: 1.5 },
      tips: ['우산을 챙기고 건물 처마·실내 동선을 이용하세요.', '흙길(숲길)·운동장 코스는 제외했어요.', '도서관·학생회관·kit라운지에서 실내 휴식을 추천해요.']
    },
    snow: {
      label: '눈', speedFactor: 1.25, excludeUnpaved: true, excludeFields: true, slopeExtra: 0.2,
      env: { open: -3, shade: 0, covered: 3.5, water: -2, forest: 0, unpaved: -4 },
      spot: { indoor: 6, cafe: 6, food: 2, rest: 2, water: -6, view: -3, open: -5, sport: -4, forest: -5, cherry: -4, fountain: -4 },
      longWalk: { thresholdM: 400, per100m: 2 },
      tips: ['빙판 오르막(오름관·대외협력관 방면)을 조심하세요.', '흙길·운동장 코스는 제외했어요.']
    },
    hot: {
      label: '폭염·강한 햇볕', speedFactor: 1.05, excludeUnpaved: false, excludeFields: false, slopeExtra: 0.05,
      env: { open: -2.5, shade: 3, covered: 2, water: 0.5, forest: 2, unpaved: -0.5 },
      spot: { indoor: 5, cafe: 5, food: 1, forest: 2, shade: 3, open: -4, sport: -4, water: 0, view: 0 },
      longWalk: { thresholdM: 900, per100m: 1 },
      tips: ['물을 챙기고 그늘·실내 구간 위주로 걸으세요.', '햇볕이 강한 장거리 야외 코스는 점수를 낮췄어요.']
    },
    cold: {
      label: '추위·강풍', speedFactor: 1.05, excludeUnpaved: false, excludeFields: false, slopeExtra: 0,
      env: { open: -2.5, shade: -0.5, covered: 3, water: -1.5, forest: 0.5, unpaved: -0.5 },
      spot: { indoor: 5, cafe: 6, food: 2, rest: 2, open: -4, water: -3, view: -1, sport: -2, forest: 0 },
      longWalk: { thresholdM: 800, per100m: 1 },
      tips: ['바람막이·장갑을 챙기세요.', '따뜻한 음료는 kit라운지·학생회관 북카페에서!']
    },
    dust: {
      label: '미세먼지 나쁨', speedFactor: 1.0, excludeUnpaved: false, excludeFields: true, slopeExtra: 0,
      env: { open: -2.5, shade: 0.5, covered: 3, water: -0.5, forest: 1, unpaved: -1 },
      spot: { indoor: 6, cafe: 4, food: 1, open: -4, sport: -5, water: -2, view: -1, forest: -1 },
      longWalk: { thresholdM: 500, per100m: 1.5 },
      tips: ['마스크를 착용하세요.', '야외 노출이 적은 짧은 실내 경유 코스를 우선했어요.']
    }
  };

  /* 계절 프로필 — feature: 특화 구간 가산(cherry/maple 등), spot/env는 날씨 프로필에 더해짐 */
  var SEASON_PROFILES = {
    spring: { label: '봄', env: {}, spot: { cherry: 9, view: 1 }, feature: { cherry: 9 },
      tips: ['봄: 오름관 옆 도로길·본관 앞 벚꽃 가로수 코스를 우대해요.'] },
    summer: { label: '여름', env: { shade: 1 }, spot: { fountain: 9, cafe: 2, shade: 2, water: 1 }, feature: {},
      tips: ['여름: 도서관 앞 분수대가 가동돼요. 그늘·라운지 경유 코스를 우대해요.'] },
    autumn: { label: '가을', env: {}, spot: { water: 4, forest: 2, view: 1 }, feature: { maple: 9 },
      tips: ['가을: 도서관 앞~디지털관 단풍길과 금오지 산책을 우대해요.'] },
    winter: { label: '겨울', env: { covered: 2 }, spot: { indoor: 3, cafe: 4, quiet: 2, view: -1, forest: -2 }, feature: {},
      longWalk: { thresholdM: 700, per100m: 1 },
      tips: ['겨울: 본관-도서관-학생회관-kit라운지 보온 코스와 짧은 금오지 코스를 우대해요.'] }
  };

  /* 시간대 프로필 — 야간에는 조명(lit) 구간 가산, 어두운 숲길·외곽 감점 */
  var TIME_PROFILES = {
    day: { label: '낮', env: {}, spot: {}, feature: {}, tips: [] },
    sunset: { label: '저녁·노을', env: { lit: 0.5 }, spot: { theater: 8, cafe: 2, view: 2, water: 1, nightview: 4 }, feature: { nightLit: 2 },
      tips: ['저녁: 노을빛 학생 소극장·북카페 구간을 추천해요.'] },
    night: { label: '야간', speedFactor: 1.05, env: { lit: 4, forest: -3, unpaved: -2, water: -1 },
      spot: { nightview: 10, theater: 3, cherry: 2, forest: -10, sport: -2, water: -2, open: -1 }, feature: { nightLit: 6 },
      longWalk: { thresholdM: 1200, per100m: 0.5 },
      tips: ['야간: 조명이 밝은 중심 도로와 글로벌관 하늘마당 야경을 우대하고, 어두운 외곽 숲길은 감점했어요.'] }
  };

  /* ---------- 유틸 ---------- */
  function round(n, d) { var p = Math.pow(10, d || 0); return Math.round(n * p) / p; }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) target[k] = s[k];
    }
    return target;
  }
  function addWeights(target, src) { if (src) for (var k in src) target[k] = (target[k] || 0) + src[k]; return target; }
  function edgeKey(a, b) { return a < b ? a + '~' + b : b + '~' + a; }
  function toDisplayScore(raw) { return Math.round(100 / (1 + Math.exp(-(raw - 72) / 18))); }

  /**
   * 날씨 × 계절 × 시간대 프로필 합성
   *  - env/spot/feature 가중치는 합산, 제외 조건은 OR, 장거리 기준은 더 엄격한 쪽, 보행 계수는 곱
   */
  var composeCache = {};
  function composeProfile(weather, season, time) {
    var wk = WEATHER_PROFILES[weather] ? weather : 'clear';
    var sk = SEASON_PROFILES[season] ? season : null;
    var tk = TIME_PROFILES[time] ? time : 'day';
    var key = wk + '|' + (sk || '-') + '|' + tk;
    if (composeCache[key]) return composeCache[key];
    var w = WEATHER_PROFILES[wk], s = sk ? SEASON_PROFILES[sk] : { env: {}, spot: {}, feature: {}, tips: [] }, t = TIME_PROFILES[tk];
    var p = {
      key: key, weather: wk, season: sk, time: tk, composed: true,
      label: w.label + (sk ? ' · ' + s.label : '') + ' · ' + t.label,
      speedFactor: (w.speedFactor || 1) * (t.speedFactor || 1),
      excludeUnpaved: !!w.excludeUnpaved, excludeFields: !!w.excludeFields, slopeExtra: w.slopeExtra || 0,
      env: addWeights(addWeights(addWeights({}, w.env), s.env), t.env),
      spot: addWeights(addWeights(addWeights({}, w.spot), s.spot), t.spot),
      feature: addWeights(addWeights({}, s.feature), t.feature),
      longWalk: assign({}, w.longWalk),
      tips: w.tips.concat(s.tips || [], t.tips || [])
    };
    [s.longWalk, t.longWalk].forEach(function (lw) {
      if (!lw) return;
      p.longWalk.thresholdM = Math.min(p.longWalk.thresholdM, lw.thresholdM);
      p.longWalk.per100m = Math.max(p.longWalk.per100m, lw.per100m);
    });
    composeCache[key] = p;
    return p;
  }

  /** 다양한 입력(문자열/ctx/프로필)을 합성 프로필로 정규화 */
  function getProfile(x) {
    if (!x) return composeProfile('clear', null, 'day');
    if (typeof x === 'string') return composeProfile(x, null, 'day');
    if (x.composed) return x;
    if (x.weather || x.season || x.time || x.category) {
      var wk = typeof x.weather === 'string' ? x.weather : (x.weather && x.weather.category) || x.category || 'clear';
      return composeProfile(wk, x.season, x.time);
    }
    return composeProfile('clear', null, 'day');
  }
  function profileKey(x) { return getProfile(x).weather; }

  function judgeSlack(availableMin, requiredMin) {
    var slack = round(availableMin - requiredMin, 1);
    var status = slack < 0 ? 'OVER' : (slack < TIGHT_MARGIN_MIN ? 'TIGHT' : 'SAFE');
    return { status: status, label: STATUS[status].label, slackMin: slack };
  }

  function walkMinutes(lengthM, speed, slopeKey, profile) {
    var sp = typeof speed === 'object' ? speed : (SPEEDS[speed] || SPEEDS.normal);
    var pf = getProfile(profile);
    var sf = SLOPE[slopeKey || 'flat'] || SLOPE.flat;
    var extra = slopeKey && slopeKey !== 'flat' ? (pf.slopeExtra || 0) : 0;
    return (lengthM * (sf.factor + extra) * (pf.speedFactor || 1)) / sp.mpm;
  }

  function edgeEnvScore(edge, profile) {
    var w = getProfile(profile).env, s = 0;
    for (var f in w) s += (w[f] || 0) * (edge.env[f] || 0);
    return s;
  }
  function edgeFeatureWeight(edge, profile) {
    var w = getProfile(profile).feature, s = 0;
    (edge.features || []).forEach(function (f) { s += w[f] || 0; });
    return s;
  }

  /* ---------- 그래프 ---------- */
  function buildGraph(data) {
    data = data || DEFAULT_DATA;
    if (!data) throw new Error('campus data not loaded');
    var nodes = {}, adj = {}, edges = [];
    data.LANDMARKS.concat(data.WAYPOINTS || []).forEach(function (n) {
      var node = assign({}, n);
      node.px = n.x / 100 * data.MAP.width;
      node.py = n.y / 100 * data.MAP.height;
      nodes[n.id] = node;
      adj[n.id] = [];
    });
    data.EDGES.forEach(function (row) {
      var a = row[0], b = row[1], type = row[2], slope = row[3] || 'flat';
      if (!nodes[a] || !nodes[b]) throw new Error('unknown node in edge: ' + a + '-' + b);
      var t = data.EDGE_TYPES[type];
      if (!t) throw new Error('unknown edge type: ' + type);
      var px = Math.hypot(nodes[a].px - nodes[b].px, nodes[a].py - nodes[b].py);
      var ov = assign({}, row[4] || {});
      var features = ov.features || [];
      var dist = ov.dist;
      delete ov.features; delete ov.dist;
      var edge = {
        id: edgeKey(a, b), a: a, b: b, type: type, typeLabel: t.label, slope: slope,
        env: assign({}, t.env, ov), features: features.slice(),
        lengthM: Math.round(dist || px * data.MAP.M_PER_PX), note: row[5] || ''
      };
      edges.push(edge);
      adj[a].push({ to: b, edge: edge });
      adj[b].push({ to: a, edge: edge });
    });
    return { data: data, nodes: nodes, adj: adj, edges: edges };
  }

  function isEdgeAllowed(edge, profile) {
    profile = getProfile(profile);
    return !(profile.excludeUnpaved && edge.env.unpaved >= 0.5);
  }

  /** 가중 비용: 길이 × 경사 × 환경 배율(0.7~1.8) × 특화 구간 배율(최소 0.6) */
  function edgeCost(edge, profile) {
    profile = getProfile(profile);
    if (!isEdgeAllowed(edge, profile)) return Infinity;
    var mul = clamp(1 - 0.06 * edgeEnvScore(edge, profile), 0.7, 1.8);
    var fmul = clamp(1 - 0.04 * edgeFeatureWeight(edge, profile), 0.6, 1);
    return edge.lengthM * (SLOPE[edge.slope] || SLOPE.flat).factor * mul * fmul;
  }

  function dijkstra(graph, src, profile) {
    var pf = getProfile(profile);
    var dist = {}, prev = {}, done = {};
    var ids = Object.keys(graph.nodes);
    ids.forEach(function (id) { dist[id] = Infinity; });
    if (!graph.nodes[src]) return { dist: dist, prev: prev };
    dist[src] = 0;
    for (;;) {
      var u = null, best = Infinity;
      for (var i = 0; i < ids.length; i++) {
        if (!done[ids[i]] && dist[ids[i]] < best) { best = dist[ids[i]]; u = ids[i]; }
      }
      if (u === null) break;
      done[u] = true;
      graph.adj[u].forEach(function (nb) {
        var c = edgeCost(nb.edge, pf);
        if (c === Infinity) return;
        var nd = dist[u] + c;
        if (nd < dist[nb.to] - 1e-9) { dist[nb.to] = nd; prev[nb.to] = { from: u, edge: nb.edge }; }
      });
    }
    return { dist: dist, prev: prev };
  }

  function pathFromTree(tree, src, dst) {
    if (src === dst) return { nodes: [src], edges: [] };
    if (!tree.prev[dst]) return null;
    var nodes = [dst], edges = [], cur = dst;
    while (cur !== src) {
      var p = tree.prev[cur];
      if (!p) return null;
      edges.unshift(p.edge);
      nodes.unshift(p.from);
      cur = p.from;
    }
    return { nodes: nodes, edges: edges };
  }

  function shortestPath(graph, a, b, profile) {
    var tree = dijkstra(graph, a, profile);
    var p = pathFromTree(tree, a, b);
    if (!p) return null;
    p.lengthM = p.edges.reduce(function (s, e) { return s + e.lengthM; }, 0);
    p.cost = tree.dist[b];
    return p;
  }

  /* ---------- 코스 계산 ---------- */
  function routeMetrics(edges, speed, profile) {
    var pf = getProfile(profile);
    var len = 0, walk = 0, envSum = 0, hill = 0, seen = {}, repeated = 0, featureM = {};
    var ratio = { open: 0, shade: 0, covered: 0, water: 0, forest: 0, unpaved: 0, lit: 0 };
    edges.forEach(function (e) {
      len += e.lengthM;
      walk += walkMinutes(e.lengthM, speed, e.slope, pf);
      envSum += edgeEnvScore(e, pf) * e.lengthM;
      if (e.slope !== 'flat') hill += e.lengthM;
      if (seen[e.id]) repeated += e.lengthM;
      else {
        seen[e.id] = true;
        (e.features || []).forEach(function (f) { featureM[f] = (featureM[f] || 0) + e.lengthM; });
      }
      for (var f in ratio) ratio[f] += (e.env[f] || 0) * e.lengthM;
    });
    for (var k in ratio) ratio[k] = len ? ratio[k] / len : 0;
    return {
      lengthM: Math.round(len), walkMin: walk, envScore: len ? envSum / len : 0,
      hillRatio: len ? hill / len : 0, repeatRatio: len ? repeated / len : 0, ratio: ratio, featureM: featureM
    };
  }

  var TITLE_SUFFIX = [
    ['nightview', '야경 코스'], ['cherry', '벚꽃길 코스'], ['fountain', '분수대 코스'], ['theater', '소극장·북카페 코스'],
    ['water', '수변 힐링 코스'], ['forest', '숲길 산림욕 코스'], ['cafe', '카페 쉼표 코스'],
    ['sport', '운동장 산책 코스'], ['view', '야외 경관 코스'], ['indoor', '실내 경유 코스']
  ];

  function courseTitle(graph, spots, pf, m) {
    if (!spots.length) {
      if (pf.feature.cherry && m.featureM.cherry) return '벚꽃 가로수 따라 바로 이동';
      if (pf.feature.maple && m.featureM.maple) return '단풍길 따라 바로 이동';
      return '최단 경로로 바로 이동';
    }
    var tags = {};
    spots.forEach(function (id) { (graph.nodes[id].spot.tags || []).forEach(function (t) { tags[t] = true; }); });
    if (pf.time !== 'sunset' && pf.time !== 'night') delete tags.theater;
    if (pf.season !== 'summer' && tags.fountain) { delete tags.fountain; tags.view = true; }
    if (pf.season === 'autumn' && pf.weather !== 'rain' && pf.weather !== 'snow' && m.featureM.maple && !tags.water && !tags.nightview) tags.mapleRoute = true;
    var suffix = '산책 코스';
    if (tags.mapleRoute) suffix = '단풍길 코스';
    else for (var i = 0; i < TITLE_SUFFIX.length; i++) if (tags[TITLE_SUFFIX[i][0]]) { suffix = TITLE_SUFFIX[i][1]; break; }
    if ((pf.weather === 'rain' || pf.weather === 'snow') && (tags.indoor || tags.cafe)) suffix = '우천 회피 ' + suffix;
    else if (pf.season === 'winter' && (tags.indoor || tags.cafe) && !tags.water) suffix = '보온 ' + suffix;
    return spots.map(function (id) { return graph.nodes[id].name; }).join('·') + ' ' + suffix;
  }

  function buildSteps(graph, legs, spots, speed, pf) {
    var steps = [];
    legs.forEach(function (leg, li) {
      var groupStart = 0;
      for (var i = 0; i < leg.edges.length; i++) {
        var e = leg.edges[i], next = leg.edges[i + 1];
        if (next && next.typeLabel === e.typeLabel && graph.nodes[leg.nodes[i + 1]].junction) continue;
        var seg = leg.edges.slice(groupStart, i + 1);
        var segLen = seg.reduce(function (s, x) { return s + x.lengthM; }, 0);
        var segMin = seg.reduce(function (s, x) { return s + walkMinutes(x.lengthM, speed, x.slope, pf); }, 0);
        var hasHill = seg.some(function (x) { return x.slope !== 'flat'; });
        var feats = {};
        seg.forEach(function (x) { (x.features || []).forEach(function (f) { if (pf.feature[f]) feats[f] = true; }); });
        var featLabel = Object.keys(feats).map(function (f) { return ((graph.data.FEATURES || {})[f] || {}).label || f; });
        steps.push({
          kind: 'walk', from: leg.nodes[groupStart], to: leg.nodes[i + 1], features: Object.keys(feats),
          text: graph.nodes[leg.nodes[groupStart]].name + ' → ' + graph.nodes[leg.nodes[i + 1]].name +
            ' (' + e.typeLabel + (hasHill ? ', 오르막/계단 포함' : '') + (featLabel.length ? ', ' + featLabel.join('·') : '') + ')',
          lengthM: segLen, minutes: segMin
        });
        groupStart = i + 1;
      }
      if (li < spots.length) {
        var sp = graph.nodes[spots[li]];
        steps.push({ kind: 'stop', at: sp.id, text: sp.name + ' — ' + (sp.spot.note || '잠깐 쉬어가기'), lengthM: 0, minutes: sp.spot.dwell });
      }
    });
    return steps;
  }

  function reasonTags(m, pf, spots, graph, judge) {
    var r = [], pct = function (v) { return Math.round(v * 100) + '%'; };
    var st = {};
    spots.forEach(function (id) { (graph.nodes[id].spot.tags || []).forEach(function (t) { st[t] = true; }); });
    var w = pf.weather, s = pf.season, t = pf.time;
    if (s === 'spring' && (m.featureM.cherry || st.cherry)) r.push(t === 'night' ? '봄밤 벚꽃길' : '봄 벚꽃길');
    if (s === 'summer' && st.fountain) r.push('여름 분수대 가동');
    if (s === 'autumn' && m.featureM.maple) r.push('가을 단풍길');
    if (s === 'autumn' && st.water) r.push('가을 금오지');
    if (s === 'winter' && m.ratio.covered >= 0.4) r.push('겨울 보온 동선');
    if (s === 'winter' && st.water && m.lengthM <= 1000) r.push('고요한 겨울 금오지');
    if (t === 'sunset' && st.theater) r.push('노을빛 소극장·북카페');
    if (t === 'night') {
      if (st.nightview) r.push('글로벌관 하늘마당 야경');
      if (m.ratio.lit >= 0.6) r.push('야간 조명 ' + pct(m.ratio.lit));
      if (m.ratio.forest > 0.05) r.push('어두운 숲길 주의');
    }
    if (w === 'clear' && t === 'day') {
      if (m.ratio.water > 0.12 || st.water) r.push('맑은 날 수변 경관');
      if (m.ratio.forest > 0.12 || st.forest) r.push('숲길 산림욕');
    }
    if (w === 'rain' || w === 'snow') {
      if (m.ratio.covered >= 0.4) r.push('건물 인접 ' + pct(m.ratio.covered) + ' · 우천 회피');
      r.push('흙길·운동장 제외');
    }
    if (w === 'hot' && m.ratio.shade >= 0.35) r.push('그늘 비중 ' + pct(m.ratio.shade));
    if ((w === 'hot' || w === 'cold' || w === 'dust') && (st.indoor || st.cafe)) r.push('실내 경유로 노출 최소화');
    if (st.cafe && r.indexOf('노을빛 소극장·북카페') < 0) r.push('카페·휴식');
    if (st.sport) r.push('가벼운 운동');
    if (m.hillRatio > 0.25) r.push('오르막 포함');
    if (judge.status === 'SAFE') r.push('수업 전 ' + Math.floor(judge.slackMin) + '분 여유');
    if (judge.status === 'TIGHT') r.push('여유 빠듯');
    return r;
  }

  function findTheme(data, id) {
    var list = (data && data.THEMES) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0] || { id: 'auto', routeWeights: {}, spotWeights: {} };
  }

  function ctxProfile(ctx) {
    var w = ctx.weather;
    if (w && w.composed) return w;
    var wk = typeof w === 'string' ? w : (w && (w.category || w.weather)) || 'clear';
    return composeProfile(wk, ctx.season, ctx.time);
  }

  /** 단일 코스 평가: spec = { start, end, spots }, ctx = { availableMin, speed, weather, season, time, theme, bufferMin } */
  function evaluateCourse(graph, spec, ctx, cache) {
    var pf = ctxProfile(ctx);
    var theme = findTheme(graph.data, ctx.theme);
    var buffer = ctx.bufferMin == null ? DEFAULT_BUFFER_MIN : ctx.bufferMin;
    var speed = SPEEDS[ctx.speed] || SPEEDS.normal;
    var spots = spec.spots || [];
    var stops = [spec.start].concat(spots, [spec.end]);
    cache = cache || {};
    var legs = [];
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stops[i], b = stops[i + 1];
      if (!cache[a]) cache[a] = dijkstra(graph, a, pf);
      var p = pathFromTree(cache[a], a, b);
      if (!p) return null;
      p.from = a; p.to = b;
      p.lengthM = p.edges.reduce(function (s, e) { return s + e.lengthM; }, 0);
      p.walkMin = p.edges.reduce(function (s, e) { return s + walkMinutes(e.lengthM, speed, e.slope, pf); }, 0);
      legs.push(p);
    }
    var allEdges = [];
    legs.forEach(function (l) { allEdges = allEdges.concat(l.edges); });
    var m = routeMetrics(allEdges, speed, pf);
    var dwell = spots.reduce(function (s, id) { return s + (graph.nodes[id].spot.dwell || 0); }, 0);
    var totalMin = m.walkMin + dwell;
    var requiredMin = totalMin + buffer;
    var judge = judgeSlack(ctx.availableMin, requiredMin);

    // ---- 점수 ----
    var bd = { weatherRoute: m.envScore * 4, contextSpots: 0, themeSpots: 0, features: 0, themeRoute: 0 };
    spots.forEach(function (id) {
      (graph.nodes[id].spot.tags || []).forEach(function (t) {
        bd.contextSpots += pf.spot[t] || 0;
        bd.themeSpots += (theme.spotWeights[t] || 0);
      });
    });
    var fw = addWeights(addWeights({}, pf.feature), theme.featureWeights);
    for (var f in fw) if (pf.feature[f]) bd.features += fw[f] * Math.min(1, (m.featureM[f] || 0) / FEATURE_FULL_M);
    for (var rf in theme.routeWeights) bd.themeRoute += theme.routeWeights[rf] * (m.ratio[rf] || 0);
    var usable = Math.max(1, ctx.availableMin - buffer);
    var util = totalMin / usable;
    bd.utilization = Math.max(-15, 12 - 30 * Math.abs(util - TARGET_UTILIZATION));
    bd.longWalk = -Math.max(0, m.lengthM - pf.longWalk.thresholdM) / 100 * pf.longWalk.per100m;
    bd.repeat = -m.repeatRatio * 10;
    bd.complexity = spots.length > 2 ? -(spots.length - 2) * 3 : 0;
    bd.status = judge.status === 'OVER' ? -40 : (judge.status === 'TIGHT' ? -8 : 0);
    var raw = 50;
    for (var k in bd) { bd[k] = round(bd[k], 1); raw += bd[k]; }

    var path = [];
    legs.forEach(function (l, li) { path = path.concat(li === 0 ? l.nodes : l.nodes.slice(1)); });
    var lastLeg = legs[legs.length - 1];
    var featureEdges = allEdges.filter(function (e) { return (e.features || []).some(function (x) { return pf.feature[x]; }); })
      .map(function (e) { return e.id; });

    return {
      key: stops.join('>'),
      start: spec.start, end: spec.end, spots: spots.slice(), stops: stops,
      title: courseTitle(graph, spots, pf, m),
      stopNames: stops.map(function (id) { return graph.nodes[id].name; }),
      legs: legs.map(function (l) { return { from: l.from, to: l.to, nodes: l.nodes, lengthM: l.lengthM, walkMin: round(l.walkMin, 1) }; }),
      path: path, featureEdges: featureEdges, featureM: m.featureM,
      lengthM: m.lengthM, walkMin: round(m.walkMin, 1), dwellMin: dwell, totalMin: round(totalMin, 1),
      bufferMin: buffer, requiredMin: round(requiredMin, 1), availableMin: ctx.availableMin,
      status: judge.status, statusLabel: judge.label, slackMin: judge.slackMin,
      returnLegMin: round(lastLeg.walkMin, 1),
      returnDepartOffsetMin: round(ctx.availableMin - buffer - lastLeg.walkMin, 1),
      returnFrom: lastLeg.from,
      ratios: m.ratio, hillRatio: m.hillRatio, repeatRatio: m.repeatRatio,
      score: round(raw, 1), displayScore: toDisplayScore(raw), breakdown: bd,
      weather: pf.weather, season: pf.season, time: pf.time, theme: theme.id,
      reasons: reasonTags(m, pf, spots, graph, judge),
      steps: buildSteps(graph, legs, spots, speed, pf)
    };
  }

  function spotAvailable(spot, pf) {
    if (pf.excludeFields && spot.field) return false;
    if (pf.excludeUnpaved && spot.unpaved) return false;
    if (spot.seasons && (!pf.season || spot.seasons.indexOf(pf.season) < 0)) return false;
    if (spot.times && spot.times.indexOf(pf.time) < 0) return false;
    return true;
  }

  function candidateSpots(graph, start, end, profile) {
    var pf = getProfile(profile);
    return Object.keys(graph.nodes).filter(function (id) {
      var n = graph.nodes[id];
      return n.spot && id !== start && id !== end && spotAvailable(n.spot, pf);
    });
  }

  function permutations(items, k) {
    var out = [];
    (function rec(prefix, used) {
      if (prefix.length === k) { out.push(prefix.slice()); return; }
      for (var i = 0; i < items.length; i++) {
        if (used[i]) continue;
        used[i] = true; prefix.push(items[i]);
        rec(prefix, used);
        prefix.pop(); used[i] = false;
      }
    })([], {});
    return out;
  }

  function jaccard(a, b) {
    if (!a.length && !b.length) return 1;
    var inter = 0, set = {};
    a.forEach(function (x) { set[x] = true; });
    b.forEach(function (x) { if (set[x]) inter++; });
    return inter / (a.length + b.length - inter);
  }

  /**
   * 추천 메인 함수
   * opts = { start, end, availableMin, speed, theme, weather, season, time, bufferMin, topN, maxSpots }
   */
  function recommend(graph, opts) {
    var ctx = {
      availableMin: Number(opts.availableMin) || 0,
      speed: opts.speed || 'normal', theme: opts.theme || 'auto',
      weather: opts.weather || 'clear', season: opts.season || null, time: opts.time || 'day',
      bufferMin: opts.bufferMin == null ? DEFAULT_BUFFER_MIN : Number(opts.bufferMin)
    };
    if (!graph.nodes[opts.start] || !graph.nodes[opts.end]) throw new Error('unknown start/end');
    var pf = ctxProfile(ctx);
    ctx.weather = pf.weather;
    var topN = opts.topN || 3;
    var maxSpots = opts.maxSpots == null ? ((pf.weather === 'rain' || pf.weather === 'snow' || pf.weather === 'dust') ? 2 : 3) : opts.maxSpots;
    var cache = {};
    var spots = candidateSpots(graph, opts.start, opts.end, pf);
    var direct = evaluateCourse(graph, { start: opts.start, end: opts.end, spots: [] }, ctx, cache);
    var all = direct ? [direct] : [];
    for (var k = 1; k <= maxSpots; k++) {
      permutations(spots, k).forEach(function (seq) {
        var c = evaluateCourse(graph, { start: opts.start, end: opts.end, spots: seq }, ctx, cache);
        if (c) all.push(c);
      });
    }
    var feasible = all.filter(function (c) { return c.status !== 'OVER'; });
    feasible.sort(function (a, b) { return b.score - a.score || a.totalMin - b.totalMin; });

    var picked = [];
    feasible.forEach(function (c) {
      if (picked.length >= topN) return;
      if (picked.every(function (p) { return jaccard(p.spots, c.spots) < 0.5; })) picked.push(c);
    });
    feasible.forEach(function (c) {
      if (picked.length >= topN) return;
      var setKey = c.spots.slice().sort().join(',');
      if (picked.indexOf(c) < 0 && picked.every(function (p) { return p.spots.slice().sort().join(',') !== setKey; })) picked.push(c);
    });

    var warning = null;
    if (!direct) warning = '현재 날씨 조건에서 갈 수 있는 경로가 없습니다.';
    else if (direct.status === 'OVER') {
      warning = '지금 바로 출발해도 수업 준비 버퍼(' + ctx.bufferMin + '분)를 지키기 어렵습니다. 최단 경로로 바로 이동하세요.';
      picked = [direct];
    } else if (picked.length === 1 && picked[0] === direct) {
      warning = '공강 시간이 짧아 산책 경유 없이 바로 이동하는 것을 추천합니다.';
    }
    picked.forEach(function (c, i) { c.rank = i + 1; });
    return {
      context: ctx, weatherKey: pf.weather, season: pf.season, time: pf.time, profile: pf,
      courses: picked, direct: direct, candidatesEvaluated: all.length, feasibleCount: feasible.length,
      warning: warning, tips: pf.tips.slice()
    };
  }

  /** 현재 계절·시간대에 강조할 특화 구간(지도 하이라이트용) */
  function activeFeatureEdges(graph, profile) {
    var pf = getProfile(profile);
    return graph.edges.filter(function (e) {
      return (e.features || []).some(function (f) { return pf.feature[f]; });
    }).map(function (e) {
      return { id: e.id, a: e.a, b: e.b, features: e.features.filter(function (f) { return pf.feature[f]; }) };
    });
  }

  function createEngine(data) {
    var graph = buildGraph(data || DEFAULT_DATA);
    return {
      graph: graph,
      recommend: function (opts) { return recommend(graph, opts); },
      evaluateCourse: function (spec, ctx) { return evaluateCourse(graph, spec, ctx); },
      shortestPath: function (a, b, profile) { return shortestPath(graph, a, b, profile); },
      activeFeatureEdges: function (profile) { return activeFeatureEdges(graph, profile); }
    };
  }

  return {
    SPEEDS: SPEEDS, SLOPE: SLOPE, STATUS: STATUS,
    WEATHER_PROFILES: WEATHER_PROFILES, SEASON_PROFILES: SEASON_PROFILES, TIME_PROFILES: TIME_PROFILES,
    DEFAULT_BUFFER_MIN: DEFAULT_BUFFER_MIN, TIGHT_MARGIN_MIN: TIGHT_MARGIN_MIN, FEATURE_FULL_M: FEATURE_FULL_M,
    composeProfile: composeProfile, getProfile: getProfile, profileKey: profileKey,
    buildGraph: buildGraph, dijkstra: dijkstra, shortestPath: shortestPath,
    walkMinutes: walkMinutes, judgeSlack: judgeSlack, edgeEnvScore: edgeEnvScore, edgeCost: edgeCost,
    edgeFeatureWeight: edgeFeatureWeight, routeMetrics: routeMetrics, toDisplayScore: toDisplayScore,
    evaluateCourse: evaluateCourse, recommend: recommend, candidateSpots: candidateSpots,
    activeFeatureEdges: activeFeatureEdges, createEngine: createEngine
  };
});
