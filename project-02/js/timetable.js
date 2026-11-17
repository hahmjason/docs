/*
 * KIT 공강 산책 — 시간표 계산 모듈
 * ------------------------------------------------------------
 *  - 시간표 항목: { id, day(0=일~6=토), start:'HH:MM', end:'HH:MM', title, building }
 *  - 현재(또는 테스트) 시각 기준으로 '다음 수업 건물 / 남은 공강 시간 / 직전 수업 건물' 계산
 *  - 예시 시간표 프리셋 제공 (저장은 app.js의 localStorage 계층에서 담당)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KITWalkTimetable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
  var HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

  function parseHM(s) {
    var m = HM_RE.exec(String(s || '').trim());
    if (!m) return NaN;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  function fmtHM(min) {
    min = Math.max(0, Math.round(min)) % 1440;
    var h = Math.floor(min / 60), m = min % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  var SAMPLE_TIMETABLE = [
    { day: 1, start: '09:00', end: '10:15', title: '자료구조',   building: 'digital' },
    { day: 1, start: '11:00', end: '12:15', title: '공학수학',   building: 'techno' },
    { day: 1, start: '14:00', end: '15:15', title: '영어회화',   building: 'global' },
    { day: 2, start: '10:30', end: '11:45', title: '회로이론',   building: 'digital' },
    { day: 2, start: '13:00', end: '14:15', title: '글쓰기',     building: 'global' },
    { day: 2, start: '15:00', end: '16:15', title: '창의설계',   building: 'techno' },
    { day: 3, start: '09:00', end: '10:15', title: '자료구조',   building: 'digital' },
    { day: 3, start: '11:00', end: '12:15', title: '공학수학',   building: 'techno' },
    { day: 3, start: '14:00', end: '15:15', title: '영어회화',   building: 'global' },
    { day: 4, start: '10:30', end: '11:45', title: '회로이론',   building: 'digital' },
    { day: 4, start: '13:00', end: '14:15', title: '글쓰기',     building: 'global' },
    { day: 5, start: '10:00', end: '11:50', title: '캡스톤디자인', building: 'techno' },
    { day: 5, start: '13:30', end: '14:45', title: '골프(교양체육)', building: 'golf' }
  ];

  function sampleTimetable() {
    return SAMPLE_TIMETABLE.map(function (e, i) {
      return { id: 'sample' + i, day: e.day, start: e.start, end: e.end, title: e.title, building: e.building };
    });
  }

  /** 항목 검증: 문제가 있으면 한국어 오류 문자열, 정상이면 null */
  function validateEntry(e, validBuildings) {
    if (!e) return '항목이 비어 있습니다.';
    if (!(e.day >= 0 && e.day <= 6)) return '요일을 선택하세요.';
    var s = parseHM(e.start), en = parseHM(e.end);
    if (isNaN(s)) return '시작 시각 형식(HH:MM)을 확인하세요.';
    if (isNaN(en)) return '종료 시각 형식(HH:MM)을 확인하세요.';
    if (en <= s) return '종료 시각은 시작 시각보다 늦어야 합니다.';
    if (!e.building || (validBuildings && validBuildings.indexOf(e.building) < 0)) return '강의 건물을 선택하세요.';
    return null;
  }

  function sortEntries(list) {
    return list.slice().sort(function (a, b) { return a.day - b.day || parseHM(a.start) - parseHM(b.start); });
  }

  function overlaps(list, e) {
    var s = parseHM(e.start), en = parseHM(e.end);
    return list.filter(function (x) {
      return x.id !== e.id && x.day === e.day && parseHM(x.start) < en && s < parseHM(x.end);
    });
  }

  /**
   * 다음 수업 계산
   * @returns { day, nowMin, current, prev, next, minutesUntil, fromBuilding, toBuilding, nextStartDate } | 오늘 남은 수업 없으면 next=null
   */
  function nextClass(list, date) {
    date = date || new Date();
    var day = date.getDay();
    var nowMin = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
    var today = sortEntries((list || []).filter(function (e) { return Number(e.day) === day; }));
    var current = null, prev = null, next = null;
    today.forEach(function (e) {
      var s = parseHM(e.start), en = parseHM(e.end);
      if (s <= nowMin && nowMin < en) current = e;
      else if (en <= nowMin) prev = e;
      else if (s > nowMin && !next) next = e;
    });
    var res = {
      day: day, dayLabel: DAY_LABELS[day], nowMin: nowMin, current: current, prev: prev, next: next,
      minutesUntil: null, fromBuilding: null, toBuilding: null, nextStartDate: null, todayCount: today.length
    };
    if (next) {
      res.minutesUntil = Math.floor(parseHM(next.start) - nowMin);
      res.toBuilding = next.building;
      var d = new Date(date.getTime());
      d.setHours(0, 0, 0, 0);
      res.nextStartDate = new Date(d.getTime() + parseHM(next.start) * 60000);
    }
    res.fromBuilding = current ? current.building : (prev ? prev.building : null);
    return res;
  }

  return {
    DAY_LABELS: DAY_LABELS, SAMPLE_TIMETABLE: SAMPLE_TIMETABLE,
    parseHM: parseHM, fmtHM: fmtHM, uid: uid, sampleTimetable: sampleTimetable,
    validateEntry: validateEntry, sortEntries: sortEntries, overlaps: overlaps, nextClass: nextClass
  };
});
