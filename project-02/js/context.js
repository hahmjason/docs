/*
 * KIT 공강 산책 — 상황(계절·시간대) 판별 어댑터
 * ------------------------------------------------------------
 *  - 계절: 봄(3~5월) · 여름(6~8월) · 가을(9~11월) · 겨울(12~2월)
 *  - 시간대: 낮(day) · 저녁·노을(sunset) · 야간(night)
 *    Open-Meteo에서 받은 일출/일몰 시각이 있으면 그것을 쓰고, 없으면 계절별 평균 일몰 시각(구미 기준)을 씁니다.
 *      저녁 = 일몰 60분 전 ~ 일몰 40분 후, 야간 = 그 이후 ~ 일출 전
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KITWalkContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SEASONS = {
    spring: { id: 'spring', label: '봄', months: [3, 4, 5] },
    summer: { id: 'summer', label: '여름', months: [6, 7, 8] },
    autumn: { id: 'autumn', label: '가을', months: [9, 10, 11] },
    winter: { id: 'winter', label: '겨울', months: [12, 1, 2] }
  };
  var TIMES = {
    day: { id: 'day', label: '낮' },
    sunset: { id: 'sunset', label: '저녁·노을' },
    night: { id: 'night', label: '야간' }
  };
  // 구미(북위 36°) 계절 평균 일출·일몰(시, 소수) — API가 없을 때 사용
  var SUN_TABLE = {
    spring: { rise: 6.2, set: 19.0 },
    summer: { rise: 5.3, set: 19.7 },
    autumn: { rise: 6.6, set: 18.0 },
    winter: { rise: 7.4, set: 17.6 }
  };
  var SUNSET_BEFORE_MIN = 60, SUNSET_AFTER_MIN = 40;

  function detectSeason(date) {
    var m = (date || new Date()).getMonth() + 1;
    for (var k in SEASONS) if (SEASONS[k].months.indexOf(m) >= 0) return k;
    return 'spring';
  }

  function hoursOf(d) { return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; }

  /** sun: { sunrise: Date|ISO, sunset: Date|ISO } (선택) */
  function detectTimeOfDay(date, sun) {
    date = date || new Date();
    var season = detectSeason(date);
    var rise = SUN_TABLE[season].rise, set = SUN_TABLE[season].set;
    if (sun && sun.sunrise && sun.sunset) {
      var r = new Date(sun.sunrise), s = new Date(sun.sunset);
      if (!isNaN(r.getTime()) && !isNaN(s.getTime())) { rise = hoursOf(r); set = hoursOf(s); }
    }
    var h = hoursOf(date);
    if (h < rise) return 'night';
    if (h < set - SUNSET_BEFORE_MIN / 60) return 'day';
    if (h < set + SUNSET_AFTER_MIN / 60) return 'sunset';
    return 'night';
  }

  /** 실제 판별값과 시뮬레이터 선택값(auto|spring...)을 합쳐 최종 상황을 결정 */
  function resolveContext(date, sun, override) {
    override = override || {};
    var autoSeason = detectSeason(date), autoTime = detectTimeOfDay(date, sun);
    var season = override.season && override.season !== 'auto' && SEASONS[override.season] ? override.season : autoSeason;
    var time = override.time && override.time !== 'auto' && TIMES[override.time] ? override.time : autoTime;
    return {
      season: season, time: time, autoSeason: autoSeason, autoTime: autoTime,
      seasonLabel: SEASONS[season].label, timeLabel: TIMES[time].label,
      simulatedSeason: season !== autoSeason, simulatedTime: time !== autoTime
    };
  }

  return {
    SEASONS: SEASONS, TIMES: TIMES, SUN_TABLE: SUN_TABLE,
    detectSeason: detectSeason, detectTimeOfDay: detectTimeOfDay, resolveContext: resolveContext
  };
});
