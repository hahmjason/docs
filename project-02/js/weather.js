/*
 * KIT 공강 산책 — 시스템 연동 계층(날씨 어댑터 & 시뮬레이터)
 * ------------------------------------------------------------
 *  - Open-Meteo(무료·API 키 불필요) 현재 날씨·오늘 일출/일몰 + 대기질(PM10/PM2.5) 조회
 *  - 응답 파싱 → 공통 관측값(obs) 형태로 정규화
 *  - 관측값 → 날씨 카테고리(clear/rain/snow/hot/cold/dust) 분류, 야외 산책 적합도 계산
 *  - 네트워크 실패 시 계절별 기본값 폴백, 테스트용 날씨 프리셋 제공
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KITWalkWeather = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 금오공과대학교(경북 구미시 대학로 61, 양호동) 대략 좌표
  var KIT_COORDS = { lat: 36.1455, lon: 128.3932, label: '금오공과대학교 (구미시 양호동)' };

  var CATEGORY_LABELS = {
    clear: '맑음·선선함', rain: '비', snow: '눈', hot: '폭염·강한 햇볕', cold: '추위·강풍', dust: '미세먼지 나쁨'
  };

  var WMO = {
    0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림', 45: '안개', 48: '서리 안개',
    51: '약한 이슬비', 53: '이슬비', 55: '강한 이슬비', 56: '어는 이슬비', 57: '강한 어는 이슬비',
    61: '약한 비', 63: '비', 65: '강한 비', 66: '어는 비', 67: '강한 어는 비',
    71: '약한 눈', 73: '눈', 75: '강한 눈', 77: '싸락눈',
    80: '약한 소나기', 81: '소나기', 82: '강한 소나기', 85: '약한 소낙눈', 86: '강한 소낙눈',
    95: '뇌우', 96: '우박 동반 뇌우', 99: '강한 우박 뇌우'
  };
  var RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];
  var SNOW_CODES = [71, 73, 75, 77, 85, 86];

  function describeCode(code) { return WMO[code] || '알 수 없음'; }

  function buildForecastUrl(c) {
    c = c || KIT_COORDS;
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + c.lat + '&longitude=' + c.lon +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day' +
      '&daily=sunrise,sunset&forecast_days=1&wind_speed_unit=ms&timezone=Asia%2FSeoul';
  }
  function buildAirUrl(c) {
    c = c || KIT_COORDS;
    return 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + c.lat + '&longitude=' + c.lon +
      '&current=pm10,pm2_5&timezone=Asia%2FSeoul';
  }

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  /** Open-Meteo forecast(+air) JSON → 공통 관측값 */
  function parseOpenMeteo(json, airJson) {
    if (!json || !json.current) throw new Error('invalid Open-Meteo response');
    var c = json.current;
    var obs = {
      tempC: num(c.temperature_2m, null),
      apparentC: num(c.apparent_temperature, num(c.temperature_2m, null)),
      humidity: num(c.relative_humidity_2m, null),
      precipMm: num(c.precipitation, 0),
      code: num(c.weather_code, 0),
      windMs: num(c.wind_speed_10m, 0),
      isDay: c.is_day == null ? true : !!c.is_day,
      time: c.time || null,
      pm10: null, pm25: null,
      sunrise: json.daily && json.daily.sunrise ? json.daily.sunrise[0] || null : null,
      sunset: json.daily && json.daily.sunset ? json.daily.sunset[0] || null : null
    };
    if (obs.tempC === null) throw new Error('missing temperature');
    if (airJson && airJson.current) {
      obs.pm10 = num(airJson.current.pm10, null);
      obs.pm25 = num(airJson.current.pm2_5, null);
    }
    return obs;
  }

  /** 관측값 → 날씨 카테고리 + 판단 근거 */
  function classify(obs) {
    var reasons = [];
    var code = obs.code, t = obs.tempC, at = obs.apparentC == null ? t : obs.apparentC;
    var precip = obs.precipMm || 0, wind = obs.windMs || 0;
    var cat = 'clear';
    if (SNOW_CODES.indexOf(code) >= 0 || (precip > 0 && t <= 0.5)) { cat = 'snow'; reasons.push('강설'); }
    else if (RAIN_CODES.indexOf(code) >= 0 || precip >= 0.1) { cat = 'rain'; reasons.push('강수 ' + precip + 'mm'); }
    else if (at >= 31 || t >= 30) { cat = 'hot'; reasons.push('체감 ' + at + '°C'); }
    else if (at <= 0 || t <= 2 || wind >= 8) { cat = 'cold'; reasons.push(wind >= 8 ? '강풍 ' + wind + 'm/s' : '체감 ' + at + '°C'); }
    else if ((obs.pm10 != null && obs.pm10 >= 81) || (obs.pm25 != null && obs.pm25 >= 36)) {
      cat = 'dust'; reasons.push('PM10 ' + obs.pm10 + ' / PM2.5 ' + obs.pm25);
    } else reasons.push(describeCode(code));
    return { category: cat, label: CATEGORY_LABELS[cat], reasons: reasons };
  }

  /** 야외 산책 적합도 0~100 + 등급 */
  function suitability(obs) {
    var s = 100, t = obs.tempC, at = obs.apparentC == null ? t : obs.apparentC, wind = obs.windMs || 0;
    var cls = classify(obs).category;
    if (cls === 'rain') s -= obs.precipMm >= 5 || obs.code === 65 || obs.code === 82 || obs.code >= 95 ? 65 : 50;
    if (cls === 'snow') s -= 55;
    if (at > 27) s -= (at - 27) * 6;
    if (at < 10) s -= (10 - at) * 3;
    if (wind > 5) s -= (wind - 5) * 5;
    if (obs.pm10 != null && obs.pm10 >= 81) s -= obs.pm10 >= 151 ? 55 : 35;
    else if (obs.pm25 != null && obs.pm25 >= 36) s -= obs.pm25 >= 76 ? 55 : 35;
    if (obs.code === 45 || obs.code === 48) s -= 10;
    if (obs.code === 3) s -= 5;
    s = Math.max(0, Math.min(100, Math.round(s)));
    var level = s >= 75 ? { id: 'best', label: '산책 최적' } : s >= 55 ? { id: 'good', label: '산책 좋음' }
      : s >= 35 ? { id: 'caution', label: '주의' } : { id: 'bad', label: '야외 비추천' };
    return { score: s, level: level };
  }

  /** 테스트 모드 프리셋 */
  var PRESETS = {
    clear: { label: '맑음',      tempC: 19,   apparentC: 19,  humidity: 50, precipMm: 0,   code: 1,  windMs: 2.1, pm10: 28,  pm25: 12 },
    rain:  { label: '비',        tempC: 14,   apparentC: 12.5, humidity: 92, precipMm: 3.2, code: 63, windMs: 4.0, pm10: 15,  pm25: 8 },
    hot:   { label: '폭염',      tempC: 33.5, apparentC: 37,  humidity: 65, precipMm: 0,   code: 0,  windMs: 1.5, pm10: 35,  pm25: 18 },
    cold:  { label: '추위·강풍', tempC: -3,   apparentC: -9,  humidity: 40, precipMm: 0,   code: 2,  windMs: 9.5, pm10: 30,  pm25: 14 },
    dust:  { label: '미세먼지',  tempC: 16,   apparentC: 16,  humidity: 45, precipMm: 0,   code: 2,  windMs: 1.2, pm10: 120, pm25: 58 },
    snow:  { label: '눈',        tempC: -1,   apparentC: -5,  humidity: 85, precipMm: 1.1, code: 73, windMs: 3.0, pm10: 20,  pm25: 10 }
  };

  function presetObs(key) {
    var p = PRESETS[key] || PRESETS.clear, o = {};
    for (var k in p) if (k !== 'label') o[k] = p[k];
    o.isDay = true; o.time = null;
    return o;
  }

  /** 계절별 기본값 — API를 못 쓸 때도 앱이 멈추지 않도록 */
  function fallbackObs(date) {
    var m = (date || new Date()).getMonth() + 1;
    var base = (m === 12 || m <= 2) ? { tempC: 3, apparentC: 0.5, code: 1, windMs: 2.5, humidity: 50 }
      : (m <= 5) ? { tempC: 17, apparentC: 17, code: 1, windMs: 2.5, humidity: 50 }
      : (m <= 8) ? { tempC: 28, apparentC: 29.5, code: 1, windMs: 1.8, humidity: 70 }
      : { tempC: 15, apparentC: 15, code: 1, windMs: 2.2, humidity: 55 };
    base.precipMm = 0; base.pm10 = null; base.pm25 = null; base.isDay = true; base.time = null;
    return base;
  }

  /** 네트워크 조회 (fetchImpl 주입 가능 → 테스트 용이) */
  function fetchWeather(opts) {
    opts = opts || {};
    var f = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : undefined) : null);
    if (!f) return Promise.reject(new Error('fetch not available'));
    var timeout = opts.timeoutMs || 6000;
    function getJson(url) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
      return Promise.race([
        f(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, timeout + 50); })
      ]).then(function (j) { clearTimeout(timer); return j; }, function (e) { clearTimeout(timer); throw e; });
    }
    var air = getJson(buildAirUrl(opts.coords)).catch(function () { return null; }); // 대기질은 선택
    return getJson(buildForecastUrl(opts.coords)).then(function (json) {
      return air.then(function (airJson) { return parseOpenMeteo(json, airJson); });
    });
  }

  return {
    KIT_COORDS: KIT_COORDS, CATEGORY_LABELS: CATEGORY_LABELS, PRESETS: PRESETS,
    describeCode: describeCode, buildForecastUrl: buildForecastUrl, buildAirUrl: buildAirUrl,
    parseOpenMeteo: parseOpenMeteo, classify: classify, suitability: suitability,
    presetObs: presetObs, fallbackObs: fallbackObs, fetchWeather: fetchWeather
  };
});
