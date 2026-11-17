/*
 * KIT 공강 산책 — 상황별 실사 사진 매칭기
 * ------------------------------------------------------------
 *  selectContextualPhoto({ focus, stops, season, weather, time }, catalog?)
 *    → { hero, gallery[], scores{}, reason }
 *  순수 함수입니다(입력이 같으면 결과가 같고, DOM·네트워크를 쓰지 않음).
 *
 *  점수 규칙
 *   - 지점 일치: focus 노드 +10, 코스 경유 노드 +8(첫 경유지 +2 추가), 출발/도착 노드 +3
 *   - 계절: 정확히 일치 +4, all +1, 불일치 −6
 *   - 시간대: 정확히 일치 +4, all +1, 불일치 −5
 *   - 분수대: fountainActive가 (season === 'summer')와 다르면 제외(여름=가동 사진, 그 외=멈춘 사진)
 *   - 지점 선택이 없을 때(전경 모드) 캠퍼스 전경 사진 +4
 *   - 비·눈: 야외 전경 사진 −1 (실내 인접 지점 사진을 조금 더 우선)
 *  동점이면 카탈로그 순서를 따릅니다.
 */
(function (root, factory) {
  var cat = root && root.KITWalkPhotos;
  if (!cat && typeof require === 'function') cat = require('../data/photo-catalog.js');
  var api = factory(cat);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KITWalkPhotoMatcher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DEFAULT_CATALOG) {
  'use strict';

  /** 한글·공백·괄호가 들어간 파일명을 안전한 상대 URL로 */
  function photoUrl(file, base) {
    return encodeURI((base == null ? './' : base) + file);
  }

  function has(list, v) { return list && list.indexOf(v) >= 0; }

  function scorePhoto(p, q) {
    var s = 0, why = [];
    var stops = q.stops || [];
    var spots = stops.length > 2 ? stops.slice(1, -1) : [];
    if (q.focus && has(p.nodes, q.focus)) { s += 10; why.push('선택 지점'); }
    var spotHit = spots.some(function (id) { return has(p.nodes, id); });
    if (spotHit) { s += 8; why.push('경유 스팟'); }
    if (spots.length && has(p.nodes, spots[0])) s += 2;
    if (!spotHit && stops.length && (has(p.nodes, stops[0]) || has(p.nodes, stops[stops.length - 1]))) { s += 3; why.push('출발/도착'); }
    if (has(p.seasons, q.season)) { s += 4; why.push('계절'); } else if (has(p.seasons, 'all')) s += 1; else s -= 6;
    if (has(p.times, q.time)) { s += 4; why.push('시간대'); } else if (has(p.times, 'all')) s += 1; else s -= 5;
    if (!q.focus && !stops.length && p.overview) { s += 4; why.push('전경'); }
    if ((q.weather === 'rain' || q.weather === 'snow') && p.overview) s -= 1;
    return { score: s, why: why };
  }

  function isExcluded(p, q) {
    if (p.fountainActive === true && q.season !== 'summer') return true;
    if (p.fountainActive === false && q.season === 'summer') return true;
    return false;
  }

  /**
   * @param q { focus?: nodeId, stops?: nodeId[] (출발→경유→도착), season, weather, time, limit? }
   */
  function selectContextualPhoto(q, catalog) {
    q = q || {};
    var photos = ((catalog || DEFAULT_CATALOG) || {}).PHOTOS || [];
    var ranked = [], scores = {};
    photos.forEach(function (p, i) {
      if (isExcluded(p, q)) { scores[p.id] = null; return; }
      var r = scorePhoto(p, q);
      scores[p.id] = r.score;
      ranked.push({ photo: p, score: r.score, why: r.why, order: i });
    });
    ranked.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
    var hero = ranked.length ? ranked[0].photo : null;
    var limit = q.limit || 6;
    return {
      hero: hero,
      gallery: ranked.slice(0, limit).map(function (r) { return r.photo; }),
      scores: scores,
      reason: ranked.length ? ranked[0].why.join(' · ') : ''
    };
  }

  /** 특정 노드의 사진 목록(상황에 맞는 순서) — 마커 팝업용 */
  function photosForNode(nodeId, q, catalog) {
    var photos = ((catalog || DEFAULT_CATALOG) || {}).PHOTOS || [];
    var mine = photos.filter(function (p) { return has(p.nodes, nodeId); });
    if (!mine.length) return [];
    var ctxq = { focus: nodeId, season: q && q.season, time: q && q.time, weather: q && q.weather };
    return selectContextualPhoto(ctxq, { PHOTOS: mine }).gallery;
  }

  return { selectContextualPhoto: selectContextualPhoto, photosForNode: photosForNode, photoUrl: photoUrl, scorePhoto: scorePhoto };
});
