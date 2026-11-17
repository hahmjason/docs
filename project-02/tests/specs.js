/*
 * KIT 공강 산책 — 핵심 로직 검증 테스트 (Node·브라우저 공용)
 *  - Node:     node tests/run-tests.js
 *  - 브라우저: tests/index.html 열기
 * 의존성 없음. defineSpecs(t, M) 형태로 테스트를 등록합니다.
 * M = { D: 공간 데이터, PH: 사진 카탈로그, E: 엔진, W: 날씨, C: 상황(계절·시간대), MT: 사진 매칭기, T: 시간표 }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.KITWalkSpecs = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function defineSpecs(t, M) {
  'use strict';
  var D = M.D, PH = M.PH, E = M.E, W = M.W, C = M.C, MT = M.MT, T = M.T;

  function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ' — expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
  function approx(a, b, eps, msg) { if (Math.abs(a - b) > (eps || 1e-6)) throw new Error((msg || 'not approx') + ' — expected ' + b + ', got ' + a); }

  var eng = E.createEngine(D);
  var G = eng.graph;
  function rec(o) {
    return eng.recommend(Object.assign({ start: 'digital', end: 'techno', availableMin: 45, speed: 'normal', theme: 'auto', bufferMin: 5, weather: 'clear', season: 'autumn', time: 'day' }, o || {}));
  }
  function spotTags(c) {
    var s = {};
    c.spots.forEach(function (id) { G.nodes[id].spot.tags.forEach(function (x) { s[x] = true; }); });
    return s;
  }
  function courseEdges(c) {
    var edges = [];
    c.legs.forEach(function (l) {
      for (var i = 0; i < l.nodes.length - 1; i++) {
        var a = l.nodes[i], b = l.nodes[i + 1];
        edges.push(G.edges.filter(function (e) { return (e.a === a && e.b === b) || (e.a === b && e.b === a); })[0]);
      }
    });
    return edges;
  }
  function hasSpot(r, id) { return r.courses.some(function (c) { return c.spots.indexOf(id) >= 0; }); }

  /* ================= ③ 데이터 ================= */
  var LEGEND = ['본관', '테크노관', '디지털관', '글로벌관', '도서관', '학생회관', '생활관', '테니스장', '대운동장', '체육관', '학군단',
    '골프학습관', '다목적운동장', '그린에너지관', '대외협력관', '풍동실험실', '이오스관', 'kit라운지', '야외음악당', '금오지', '정문'];

  t.test('데이터: 범례 21개 지점(번호·이름) + 생활관에 오름관 병기', function () {
    eq(D.LANDMARKS.length, 21, '지점 수');
    LEGEND.forEach(function (name, i) {
      var n = D.LANDMARKS.filter(function (x) { return x.num === i + 1; })[0];
      ok(n, (i + 1) + '번 없음');
      eq(n.legendName, name, (i + 1) + '번 범례명');
    });
    eq(G.nodes.dorm.name, '생활관(오름관)');
    var ids = {};
    D.LANDMARKS.concat(D.WAYPOINTS).forEach(function (n) { ok(!ids[n.id], '중복 id ' + n.id); ids[n.id] = true; });
  });

  t.test('데이터: 도서관 앞 분수대 노드가 도서관 근처에 있고 도서관과 직접 연결', function () {
    var f = G.nodes.fountain, l = G.nodes.library;
    ok(f && f.spot && f.spot.tags.indexOf('fountain') >= 0, '분수대 스팟');
    ok(Math.hypot(f.px - l.px, f.py - l.py) * D.MAP.M_PER_PX < 120, '도서관과 120m 이내');
    ok(eng.shortestPath('library', 'fountain').nodes.length === 2, '직접 연결');
  });

  t.test('데이터: 모든 좌표가 지도 그림 영역 안(원본 범례 영역 제외)', function () {
    D.LANDMARKS.concat(D.WAYPOINTS).forEach(function (n) {
      ok(n.x > 0 && n.x < 100, n.name + ' x=' + n.x);
      ok(n.y > 0 && n.y < D.MAP.mapAreaBottom, n.name + ' y=' + n.y);
    });
  });

  t.test('데이터: 엣지가 유효한 노드·유형·난이도·특화 태그·조명값을 가짐', function () {
    D.EDGES.forEach(function (e) {
      ok(G.nodes[e[0]] && G.nodes[e[1]], '노드 없음 ' + e[0] + '-' + e[1]);
      ok(D.EDGE_TYPES[e[2]], '유형 없음 ' + e[2]);
      ok(E.SLOPE[e[3]], '난이도 없음 ' + e[3]);
    });
    G.edges.forEach(function (e) {
      ok(e.lengthM > 0, e.id + ' 길이 0');
      ok(e.env.lit >= 0 && e.env.lit <= 1, e.id + ' 조명값');
      e.features.forEach(function (f) { ok(D.FEATURES[f], e.id + ' 알 수 없는 특화 태그 ' + f); });
    });
    ['cherry', 'maple', 'nightLit'].forEach(function (f) {
      ok(G.edges.some(function (e) { return e.features.indexOf(f) >= 0; }), f + ' 구간 존재');
    });
    var maple = G.edges.filter(function (e) { return e.features.indexOf('maple') >= 0; }).map(function (e) { return e.id; });
    ok(maple.indexOf('digital~library') >= 0, '도서관 앞~디지털관 단풍길');
    ok(G.edges.filter(function (e) { return e.id === 'dorm~jNW'; })[0].features.indexOf('cherry') >= 0, '오름관 옆 벚꽃 도로길');
  });

  t.test('데이터: 보행 그래프가 하나로 연결됨(정문에서 모든 노드 도달)', function () {
    var tree = E.dijkstra(G, 'gate', 'clear');
    Object.keys(G.nodes).forEach(function (id) { ok(isFinite(tree.dist[id]), id + ' 도달 불가'); });
  });

  t.test('사진 카탈로그: 11장, 필수 필드·태그 값·노드 매핑이 유효', function () {
    eq(PH.PHOTOS.length, 11, '사진 수');
    var files = {};
    PH.PHOTOS.forEach(function (p) {
      ok(p.id && p.file && p.caption, p.id + ' 필드');
      ok(!files[p.file], '중복 파일 ' + p.file); files[p.file] = true;
      p.seasons.forEach(function (s) { ok(['spring', 'summer', 'autumn', 'winter', 'all'].indexOf(s) >= 0, p.id + ' 계절 ' + s); });
      p.times.forEach(function (s) { ok(['day', 'sunset', 'night', 'all'].indexOf(s) >= 0, p.id + ' 시간대 ' + s); });
      p.nodes.forEach(function (n) { ok(n === 'campus' || G.nodes[n], p.id + ' 노드 ' + n); });
      ok(p.fountainActive === null || typeof p.fountainActive === 'boolean', p.id + ' fountainActive');
    });
    var fountains = PH.PHOTOS.filter(function (p) { return p.fountainActive !== null; });
    eq(fountains.length, 2, '분수대 사진 2장');
    ok(PH.ASSETS.intro.file === '웹사이트 인트로.gif' && PH.ASSETS.campusMap.file === 'kumoh_ac_kr_20120125_164421.jpg', '자산');
  });

  /* ================= ② 도보 경로 / 시간 계산 ================= */
  t.test('경로: 도서관↔학생회관 직접 연결, 양방향 거리 동일', function () {
    var a = eng.shortestPath('library', 'studentHall', 'clear'), b = eng.shortestPath('studentHall', 'library', 'clear');
    eq(a.nodes.length, 2, '직접 연결'); eq(a.lengthM, b.lengthM, '대칭');
  });

  t.test('경로: 최단 경로 비용이 삼각 부등식을 만족(날씨·계절·야간 모두)', function () {
    var ids = ['gate', 'library', 'dorm', 'stadium', 'pond', 'golf', 'cooperation', 'fountain'];
    [E.composeProfile('clear', 'autumn', 'day'), E.composeProfile('rain', 'spring', 'night')].forEach(function (pf) {
      var trees = {};
      ids.forEach(function (id) { trees[id] = E.dijkstra(G, id, pf); });
      ids.forEach(function (a) { ids.forEach(function (b) { ids.forEach(function (c) {
        ok(trees[a].dist[c] <= trees[a].dist[b] + trees[b].dist[c] + 1e-6, pf.key + ' ' + a + '→' + c + ' via ' + b);
      }); }); });
    });
  });

  t.test('경로: 정문→도서관 300~800m, 대운동장→정문 1km 초과', function () {
    var g2l = eng.shortestPath('gate', 'library', 'clear').lengthM;
    ok(g2l >= 300 && g2l <= 800, '정문→도서관 ' + g2l);
    ok(eng.shortestPath('stadium', 'gate', 'clear').lengthM > 1000, '대운동장→정문');
  });

  t.test('시간: 걷기 속도·오르막·날씨·야간 보정', function () {
    approx(E.walkMinutes(700, 'normal', 'flat', 'clear'), 10, 1e-9, '700m 보통 평지 = 10분');
    approx(E.walkMinutes(700, 'normal', 'hill', 'clear'), 12, 1e-9, '오르막 1.2배');
    approx(E.walkMinutes(700, 'normal', 'stairs', 'clear'), 13, 1e-9, '계단 1.3배');
    ok(E.walkMinutes(700, 'slow', 'flat', 'clear') > E.walkMinutes(700, 'fast', 'flat', 'clear'), '느긋 > 빠르게');
    approx(E.walkMinutes(700, 'normal', 'flat', 'rain'), 11, 1e-9, '비 1.1배');
    approx(E.walkMinutes(700, 'normal', 'flat', E.composeProfile('clear', 'autumn', 'night')), 10.5, 1e-9, '야간 1.05배');
    ok(E.walkMinutes(700, 'normal', 'hill', 'snow') > E.walkMinutes(700, 'normal', 'hill', 'rain'), '눈 오르막이 더 오래');
  });

  t.test('시간: 코스 소요 = 걷기 + 경유 휴식, 필요 = 소요 + 버퍼, 경로 연속성', function () {
    rec({ availableMin: 60 }).courses.forEach(function (c) {
      var dwell = c.spots.reduce(function (s, id) { return s + G.nodes[id].spot.dwell; }, 0);
      eq(c.dwellMin, dwell, '휴식 합');
      approx(c.totalMin, c.walkMin + c.dwellMin, 0.11, '소요');
      approx(c.requiredMin, c.totalMin + c.bufferMin, 0.11, '필요');
      eq(c.legs.reduce(function (s, l) { return s + l.lengthM; }, 0), c.lengthM, '구간 거리 합');
      eq(c.path[0], c.start); eq(c.path[c.path.length - 1], c.end);
    });
  });

  /* ================= ② 공강 여유 판정 ================= */
  t.test('판정: SAFE / TIGHT / OVER 경계값', function () {
    eq(E.judgeSlack(30, 20).status, 'SAFE');
    eq(E.judgeSlack(30, 27).status, 'SAFE', '여유 3분은 SAFE');
    eq(E.judgeSlack(30, 28).status, 'TIGHT');
    eq(E.judgeSlack(30, 30).status, 'TIGHT', '딱 맞으면 TIGHT');
    eq(E.judgeSlack(30, 30.5).status, 'OVER');
    eq(E.judgeSlack(30, 31).slackMin, -1);
  });

  t.test('추천: 모든 날씨×계절×시간대에서 지각 위험(OVER) 코스는 추천하지 않음', function () {
    [15, 40, 90].forEach(function (m) {
      ['clear', 'rain', 'hot', 'cold'].forEach(function (w) {
        ['spring', 'summer', 'autumn', 'winter'].forEach(function (s) {
          ['day', 'sunset', 'night'].forEach(function (tm) {
            var r = rec({ availableMin: m, weather: w, season: s, time: tm, start: 'dorm', end: 'main' });
            ok(r.courses.length >= 1, [m, w, s, tm].join('/') + ' 결과 없음');
            if (r.direct.status !== 'OVER') r.courses.forEach(function (c) {
              ok(c.status !== 'OVER' && c.requiredMin <= m, [m, w, s, tm].join('/') + ' ' + c.title + ' 초과');
            });
          });
        });
      });
    });
  });

  t.test('추천: 공강이 너무 짧으면 바로 이동 + 지각 위험 경고', function () {
    var r = rec({ start: 'stadium', end: 'gate', availableMin: 8 });
    eq(r.courses.length, 1); eq(r.courses[0].spots.length, 0); eq(r.courses[0].status, 'OVER');
    ok(r.warning && /버퍼/.test(r.warning) && /바로 이동/.test(r.warning), '경고 문구: ' + r.warning);
  });

  t.test('추천: TOP3는 경유 스팟 구성이 서로 다르고 점수 내림차순', function () {
    var r = rec({ availableMin: 60 });
    eq(r.courses.length, 3);
    var keys = r.courses.map(function (c) { return c.spots.slice().sort().join(','); });
    ok(keys[0] !== keys[1] && keys[1] !== keys[2] && keys[0] !== keys[2], keys.join(' | '));
    ok(r.courses[0].score >= r.courses[1].score && r.courses[1].score >= r.courses[2].score, '내림차순');
  });

  t.test('추천: 복귀 출발 권장 시각 = 남은 시간 − 버퍼 − 마지막 구간 걷기', function () {
    var c = rec({ availableMin: 50 }).courses[0];
    approx(c.returnDepartOffsetMin, 50 - c.bufferMin - c.returnLegMin, 0.11);
    eq(c.returnFrom, c.spots.length ? c.spots[c.spots.length - 1] : c.start);
  });

  /* ================= ② 날씨·계절·시간대 가중치 ================= */
  t.test('프로필 합성: 가중치 합산·제외 조건·장거리 기준', function () {
    var p = E.composeProfile('rain', 'winter', 'night');
    eq(p.weather, 'rain'); eq(p.season, 'winter'); eq(p.time, 'night');
    eq(p.env.covered, E.WEATHER_PROFILES.rain.env.covered + E.SEASON_PROFILES.winter.env.covered, 'covered 합산');
    eq(p.env.lit, E.TIME_PROFILES.night.env.lit, '야간 조명 가중');
    ok(p.excludeUnpaved, '비 → 흙길 제외 유지');
    eq(p.longWalk.thresholdM, 500, '더 엄격한 장거리 기준');
    ok(E.composeProfile('clear', 'spring', 'day') === E.composeProfile('clear', 'spring', 'day'), '캐시');
  });

  t.test('날씨: 수변길은 맑음 가산·비 감점, 처마길은 비 가산, 비에는 숲길 제외', function () {
    var lake = G.edges.filter(function (e) { return e.type === 'lakeside'; })[0];
    var arcade = G.edges.filter(function (e) { return e.type === 'arcade'; })[0];
    var forest = G.edges.filter(function (e) { return e.type === 'forest'; })[0];
    ok(E.edgeEnvScore(lake, 'clear') > 0 && E.edgeEnvScore(lake, 'rain') < 0 && E.edgeEnvScore(arcade, 'rain') > 0, '부호');
    eq(E.edgeCost(forest, 'rain'), Infinity, '숲길 제외');
  });

  t.test('맑음(가을 낮): TOP1이 금오지·야외음악당·숲길 등 야외 경관 코스', function () {
    var c = rec({ availableMin: 45 }).courses[0], s = spotTags(c);
    ok(s.water || s.view || s.forest, c.title);
  });

  t.test('비·폭염: 장거리 야외 감점, 도서관·학생회관·kit라운지 등 실내 인접 회피 코스 우선', function () {
    var clear = rec({ availableMin: 45 }).courses[0];
    ['rain', 'hot'].forEach(function (w) {
      var r = rec({ availableMin: 45, weather: w }), top = r.courses[0], tg = spotTags(top);
      ok(tg.indoor || tg.cafe, w + ' 실내 경유: ' + top.title);
      ok(top.lengthM < clear.lengthM, w + ' 더 짧은 코스');
      ok(top.ratios.covered > clear.ratios.covered, w + ' 건물 인접 비율');
    });
    rec({ availableMin: 45, weather: 'rain' }).courses.forEach(function (c) {
      courseEdges(c).forEach(function (e) { ok(e.env.unpaved < 0.5, c.title + ' 흙길 포함'); });
      c.spots.forEach(function (id) { ok(!G.nodes[id].spot.field && !G.nodes[id].spot.unpaved, c.title + ' 운동장/숲'); });
    });
    ok(rec({ weather: 'rain' }).tips.join(' ').indexOf('우산') >= 0, '우산 팁');
  });

  t.test('봄: 오름관 벚꽃 도로길·본관 벚꽃 가로수 코스 가산, 봄 외에는 벚꽃 스팟 제외', function () {
    var r = rec({ season: 'spring', availableMin: 45 });
    var top = r.courses[0];
    ok(top.featureM.cherry > 0 || spotTags(top).cherry, '벚꽃 포함: ' + top.title);
    ok(top.reasons.some(function (x) { return /벚꽃/.test(x); }), '사유 태그');
    ok(E.candidateSpots(G, 'digital', 'techno', E.composeProfile('clear', 'spring', 'day')).indexOf('dorm') >= 0, '봄 오름관 스팟');
    ok(E.candidateSpots(G, 'digital', 'techno', E.composeProfile('clear', 'autumn', 'day')).indexOf('dorm') < 0, '가을엔 제외');
    var cherryEdge = G.edges.filter(function (e) { return e.id === 'dorm~jNW'; })[0];
    ok(E.edgeCost(cherryEdge, E.composeProfile('clear', 'spring', 'day')) < E.edgeCost(cherryEdge, E.composeProfile('clear', 'autumn', 'day')), '봄 벚꽃 구간 비용↓');
  });

  t.test('여름: 도서관 앞 분수대(가동) 경유 코스 가산', function () {
    var top = rec({ season: 'summer', availableMin: 45 }).courses[0];
    ok(top.spots.indexOf('fountain') >= 0, top.title);
    ok(top.reasons.indexOf('여름 분수대 가동') >= 0, '사유 태그');
    var sum = E.composeProfile('clear', 'summer', 'day'), aut = E.composeProfile('clear', 'autumn', 'day');
    ok(sum.spot.fountain > (aut.spot.fountain || 0), '분수대 가중치');
  });

  t.test('가을: 도서관 앞~디지털관 단풍길 & 금오지 코스 가산', function () {
    var r = rec({ season: 'autumn', availableMin: 45 });
    ok(r.courses.some(function (c) { return c.featureM.maple > 0; }), '단풍길 포함 코스');
    ok(hasSpot(r, 'pond'), '금오지 포함 코스');
    var autumnTop = r.courses[0], springTop = rec({ season: 'spring', availableMin: 45 }).courses[0];
    ok(autumnTop.breakdown.features > 0, '가을 특화 점수');
    ok(autumnTop.title !== springTop.title, '계절에 따라 추천이 달라짐');
  });

  t.test('겨울: 짧고 건물 밀집 보온 코스(도서관·학생회관·kit라운지) 우대', function () {
    var w = rec({ season: 'winter', availableMin: 45 }).courses[0], a = rec({ season: 'autumn', availableMin: 45 }).courses[0];
    ok(w.lengthM < a.lengthM, '겨울이 더 짧음 ' + w.lengthM + ' < ' + a.lengthM);
    ok(w.ratios.covered > a.ratios.covered, '건물 인접 비율');
    var tg = spotTags(w);
    ok(tg.indoor || tg.cafe, w.title);
  });

  t.test('저녁: 학생회관 옆 소극장·북카페 구간 우대', function () {
    var r = rec({ time: 'sunset', availableMin: 45 });
    ok(hasSpot(r, 'studentHall'), '학생회관 경유');
    ok(r.courses.some(function (c) { return c.reasons.indexOf('노을빛 소극장·북카페') >= 0; }), '사유 태그');
  });

  t.test('야간: 조명 중심 동선·글로벌관 야경 우대, 어두운 숲길 감점', function () {
    var night = rec({ time: 'night', availableMin: 45 }), day = rec({ time: 'day', availableMin: 45 });
    ok(hasSpot(night, 'global'), '글로벌관 야경 스팟');
    ok(E.candidateSpots(G, 'digital', 'techno', E.composeProfile('clear', 'autumn', 'day')).indexOf('global') < 0, '낮엔 야경 스팟 없음');
    night.courses.forEach(function (c) { ok(c.spots.indexOf('forest') < 0, '야간 숲길 경유 금지: ' + c.title); });
    ok(night.courses[0].ratios.lit > day.courses[0].ratios.lit, '조명 비율 ' + night.courses[0].ratios.lit + ' > ' + day.courses[0].ratios.lit);
    var forestEdge = G.edges.filter(function (e) { return e.type === 'forest'; })[0];
    ok(E.edgeCost(forestEdge, E.composeProfile('clear', 'autumn', 'night')) > E.edgeCost(forestEdge, E.composeProfile('clear', 'autumn', 'day')), '야간 숲길 비용↑');
    var springNight = rec({ time: 'night', season: 'spring', availableMin: 45 });
    ok(springNight.courses.some(function (c) { return c.reasons.indexOf('봄밤 벚꽃길') >= 0; }), '봄 야간 벚꽃길');
  });

  t.test('지도 하이라이트: 계절·시간대별 특화 구간 선택', function () {
    var spring = eng.activeFeatureEdges(E.composeProfile('clear', 'spring', 'day'));
    ok(spring.length && spring.every(function (e) { return e.features.indexOf('cherry') >= 0; }), '봄=벚꽃');
    ok(eng.activeFeatureEdges(E.composeProfile('clear', 'autumn', 'day')).every(function (e) { return e.features.indexOf('maple') >= 0; }), '가을=단풍');
    ok(eng.activeFeatureEdges(E.composeProfile('clear', 'winter', 'night')).every(function (e) { return e.features.indexOf('nightLit') >= 0; }), '야간=조명');
    eq(eng.activeFeatureEdges(E.composeProfile('clear', 'summer', 'day')).length, 0, '여름 낮은 구간 하이라이트 없음(분수대 마커로 표시)');
  });

  /* ================= ② 사진 매칭기 ================= */
  function sel(q) { return MT.selectContextualPhoto(q).hero.id; }

  t.test('사진 매칭: 분수대는 여름=작동 사진, 그 외 계절=멈춘 사진', function () {
    eq(sel({ focus: 'fountain', season: 'summer', time: 'day', weather: 'clear' }), 'fountainOn');
    ['spring', 'autumn', 'winter'].forEach(function (s) { eq(sel({ focus: 'fountain', season: s, time: 'day', weather: 'clear' }), 'fountainOff', s); });
    var g = MT.selectContextualPhoto({ season: 'winter', time: 'day' }).gallery;
    ok(g.every(function (p) { return p.id !== 'fountainOn'; }), '여름 외 갤러리에 가동 사진 없음');
  });

  t.test('사진 매칭: 낮→저녁→야간 전환 시 전경 → 학생 소극장 → 글로벌관 야경', function () {
    eq(sel({ season: 'autumn', time: 'day', weather: 'clear' }), 'overview');
    eq(sel({ season: 'autumn', time: 'sunset', weather: 'clear' }), 'theater');
    eq(sel({ season: 'autumn', time: 'night', weather: 'clear' }), 'globalNight');
    eq(MT.selectContextualPhoto({ season: 'autumn', time: 'day' }).hero.file, 'KakaoTalk_20261116_200729883_02.webp');
  });

  t.test('사진 매칭: 선택 스팟·코스·계절에 맞는 사진', function () {
    eq(sel({ focus: 'dorm', season: 'spring', time: 'night' }), 'cherryNight', '봄밤 오름관');
    eq(sel({ focus: 'main', season: 'spring', time: 'day' }), 'mainCherry', '봄 본관');
    eq(sel({ focus: 'main', season: 'autumn', time: 'day' }), 'pond', '가을 본관 → 금오지 반영 사진');
    eq(sel({ focus: 'digital', season: 'autumn', time: 'day' }), 'autumnRoad', '가을 디지털관 단풍길');
    eq(sel({ focus: 'gate', season: 'winter', time: 'day' }), 'gate');
    eq(sel({ stops: ['digital', 'pond', 'techno'], season: 'autumn', time: 'day' }), 'pond', '코스 경유 금오지');
    eq(sel({ stops: ['digital', 'studentHall', 'techno'], season: 'autumn', time: 'sunset' }), 'theater', '저녁 학생회관');
    eq(sel({ stops: ['digital', 'global', 'techno'], season: 'winter', time: 'night' }), 'globalNight', '야간 글로벌관');
  });

  t.test('사진 매칭: 순수 함수(같은 입력→같은 결과)·갤러리·URL 인코딩', function () {
    var q = { stops: ['digital', 'fountain', 'pond', 'techno'], season: 'summer', time: 'day', weather: 'clear', limit: 5 };
    var a = MT.selectContextualPhoto(q), b = MT.selectContextualPhoto(q);
    eq(a.hero.id, b.hero.id); eq(JSON.stringify(a.gallery.map(function (p) { return p.id; })), JSON.stringify(b.gallery.map(function (p) { return p.id; })));
    eq(a.gallery.length, 5); eq(a.gallery[0], a.hero);
    eq(MT.photoUrl('금오공대 벗꽃.jpg'), './%EA%B8%88%EC%98%A4%EA%B3%B5%EB%8C%80%20%EB%B2%97%EA%BD%83.jpg');
    eq(MT.photoUrl('금오지(금오공대 연못).jpg').indexOf(' '), -1, '공백 인코딩');
    eq(MT.photosForNode('fountain', { season: 'summer', time: 'day' })[0].id, 'fountainOn');
    eq(MT.photosForNode('techno', { season: 'summer', time: 'day' }).length, 0, '사진 없는 지점');
  });

  /* ================= ④ 날씨·상황 어댑터 ================= */
  t.test('계절 판별: 3~5 봄, 6~8 여름, 9~11 가을, 12~2 겨울', function () {
    var exp = { 1: 'winter', 2: 'winter', 3: 'spring', 5: 'spring', 6: 'summer', 8: 'summer', 9: 'autumn', 11: 'autumn', 12: 'winter' };
    Object.keys(exp).forEach(function (m) { eq(C.detectSeason(new Date(2026, Number(m) - 1, 15, 12)), exp[m], m + '월'); });
  });

  t.test('시간대 판별: 낮/저녁·노을/야간 (평균 일몰표 & API 일출·일몰)', function () {
    eq(C.detectTimeOfDay(new Date(2026, 10, 16, 12, 0)), 'day');
    eq(C.detectTimeOfDay(new Date(2026, 10, 16, 17, 30)), 'sunset', '가을 일몰 18:00 전후');
    eq(C.detectTimeOfDay(new Date(2026, 10, 16, 20, 7)), 'night');
    eq(C.detectTimeOfDay(new Date(2026, 10, 16, 5, 0)), 'night', '일출 전');
    eq(C.detectTimeOfDay(new Date(2026, 6, 16, 18, 0)), 'day', '여름 18시는 낮');
    var sun = { sunrise: '2026-11-16T07:05', sunset: '2026-11-16T17:24' };
    eq(C.detectTimeOfDay(new Date(2026, 10, 16, 16, 30), sun), 'sunset', 'API 일몰 기준');
    eq(C.detectTimeOfDay(new Date(2026, 10, 16, 18, 10), sun), 'night');
    var r = C.resolveContext(new Date(2026, 10, 16, 12), null, { season: 'spring', time: 'auto' });
    eq(r.season, 'spring'); eq(r.time, 'day'); ok(r.simulatedSeason && !r.simulatedTime, '시뮬레이터 표시');
  });

  t.test('날씨 분류: 코드·기온·바람·미세먼지 → 카테고리', function () {
    function o(x) { return Object.assign({ tempC: 18, apparentC: 18, code: 1, precipMm: 0, windMs: 2, pm10: 20, pm25: 10 }, x); }
    eq(W.classify(o({})).category, 'clear');
    eq(W.classify(o({ code: 63, precipMm: 2 })).category, 'rain');
    eq(W.classify(o({ code: 3, precipMm: 0.4 })).category, 'rain');
    eq(W.classify(o({ code: 73, tempC: -1 })).category, 'snow');
    eq(W.classify(o({ tempC: 33, apparentC: 36 })).category, 'hot');
    eq(W.classify(o({ windMs: 10 })).category, 'cold');
    eq(W.classify(o({ pm10: 120 })).category, 'dust');
    Object.keys(W.PRESETS).forEach(function (k) { eq(W.classify(W.presetObs(k)).category, k, '프리셋 ' + k); });
  });

  t.test('Open-Meteo 응답 파싱(일출·일몰 포함)과 모의 fetch 성공/실패', function () {
    var obs = W.parseOpenMeteo({ current: { temperature_2m: 9.4, apparent_temperature: 7.1, weather_code: 2, wind_speed_10m: 3.2, precipitation: 0 },
      daily: { sunrise: ['2026-11-16T07:05'], sunset: ['2026-11-16T17:24'] } }, { current: { pm10: 42, pm2_5: 21 } });
    eq(obs.tempC, 9.4); eq(obs.pm10, 42); eq(obs.sunset, '2026-11-16T17:24');
    ok(W.buildForecastUrl().indexOf('daily=sunrise,sunset') > 0, 'URL');
    var threw = false; try { W.parseOpenMeteo({}); } catch (e) { threw = true; } ok(threw, '빈 응답 예외');
    var okFetch = function (url) {
      var body = url.indexOf('air-quality') >= 0 ? { current: { pm10: 30, pm2_5: 12 } } : { current: { temperature_2m: 21, weather_code: 0 } };
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } });
    };
    return W.fetchWeather({ fetchImpl: okFetch }).then(function (o) {
      eq(o.tempC, 21); eq(o.pm10, 30);
      return W.fetchWeather({ fetchImpl: function () { return Promise.reject(new Error('offline')); } })
        .then(function () { throw new Error('should fail'); }, function (e) { eq(e.message, 'offline'); });
    });
  });

  /* ================= ③④ 시간표 ================= */
  var tt = T.sampleTimetable();
  t.test('시간표: 월 10:20 → 다음 수업 공학수학(테크노관) 40분 전, 현재 위치 디지털관', function () {
    var r = T.nextClass(tt, new Date(2026, 10, 16, 10, 20));
    eq(r.next.title, '공학수학'); eq(r.toBuilding, 'techno'); eq(r.minutesUntil, 40); eq(r.fromBuilding, 'digital');
  });
  t.test('시간표: 수업 중이면 현재 수업 건물에서 다음 수업까지, 이후·주말은 없음', function () {
    var r = T.nextClass(tt, new Date(2026, 10, 16, 11, 30));
    eq(r.current.title, '공학수학'); eq(r.next.title, '영어회화'); eq(r.minutesUntil, 150);
    eq(T.nextClass(tt, new Date(2026, 10, 16, 16, 0)).next, null);
    eq(T.nextClass(tt, new Date(2026, 10, 21, 10, 0)).next, null, '토요일');
    eq(T.nextClass(tt, new Date(2026, 10, 16, 10, 20, 30)).minutesUntil, 39, '초 단위 내림');
  });
  t.test('시간표: 입력 검증·겹침 검사·시각 변환', function () {
    var ids = D.LANDMARKS.map(function (n) { return n.id; });
    eq(T.validateEntry({ day: 1, start: '09:00', end: '10:00', building: 'digital' }, ids), null);
    ok(T.validateEntry({ day: 1, start: '10:00', end: '09:00', building: 'digital' }, ids), '역순');
    ok(T.validateEntry({ day: 1, start: '09:00', end: '10:00', building: 'nowhere' }, ids), '건물');
    eq(T.overlaps(tt, { id: 'x', day: 1, start: '10:00', end: '11:30' }).length, 2);
    eq(T.parseHM('13:05'), 785); eq(T.fmtHM(785), '13:05');
  });

  t.test('통합: 시간표 + 현재 시각 → 계절·시간대·다음 수업 → 추천 → 대표 사진', function () {
    var now = new Date(2026, 10, 16, 10, 20);
    var cx = C.resolveContext(now);
    var r = T.nextClass(tt, now);
    var res = eng.recommend({ start: r.fromBuilding, end: r.toBuilding, availableMin: r.minutesUntil, weather: 'clear', season: cx.season, time: cx.time });
    eq(cx.season, 'autumn'); eq(cx.time, 'day');
    eq(res.courses.length, 3);
    res.courses.forEach(function (c) { eq(c.start, 'digital'); eq(c.end, 'techno'); ok(c.requiredMin <= 40, '40분 내'); });
    var ph = MT.selectContextualPhoto({ stops: res.courses[0].stops, season: cx.season, time: cx.time, weather: 'clear' }).hero;
    ok(ph && ph.file, '대표 사진');
  });
});
