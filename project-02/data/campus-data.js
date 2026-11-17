/*
 * KIT 공강 산책 — 캠퍼스 공간 정적 데이터 모듈
 * ------------------------------------------------------------
 * - 좌표(x, y)는 캠퍼스맵 이미지(kumoh_ac_kr_20120125_164421.jpg, 550×397px) 전체 크기에 대한 백분율(%)입니다.
 * - 원본 지도에는 번호 표시가 없으므로 건물 모양·배치·캠퍼스 설명(예: 풍동실험실은 도서관 주차장 우측 도로,
 *   학군단은 체육관 우측, 골프학습관은 학군단 우측)을 근거로 추정한 위치입니다. 앱의 "좌표 보정 모드"로 미세조정할 수 있습니다.
 * - 거리(m)는 이미지 픽셀 거리 × M_PER_PX(추정 축척)로 계산합니다.
 * - 빌드 없이 <script>로 읽히고(Node에서는 require) 전역 KITWalkData로 노출됩니다.
 */
(function (root, factory) {
  var data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.KITWalkData = data;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAP = {
    image: 'kumoh_ac_kr_20120125_164421.jpg',
    width: 550,
    height: 397,
    mapAreaBottom: 78.6, // 지도 그림 영역 하단(%) — 그 아래는 원본 범례(기본 화면에서는 잘라서 표시)
    M_PER_PX: 2.6        // 추정 축척: 이미지 1px ≈ 2.6m (정문→도서관 약 520m)
  };

  /*
   * 21개 주요 지점(범례 번호 순서)
   *  legendName: 원본 지도 범례 표기, name: 앱 표기(생활관은 '오름관' 병기)
   *  spot: 산책 경유지 정보 — dwell(머무는 분), tags(성격), outdoor, field(운동장류), unpaved(흙길),
   *        seasons/times(그 계절·시간대에만 경유지로 추천)
   */
  var LANDMARKS = [
    { id: 'main', num: 1, legendName: '본관', name: '본관', x: 63.27, y: 54.91, category: 'admin',
      tags: ['대학본부', '벚꽃 가로수', '금오지 인접'], desc: '총장실·입학관리본부가 있는 대학본부. 봄이면 앞길에 벚꽃 가로수가 핍니다.',
      spot: { dwell: 2, tags: ['cherry', 'view'], outdoor: true, seasons: ['spring'], note: '본관 앞 벚꽃 가로수 아래 걷기' } },
    { id: 'techno', num: 2, legendName: '테크노관', name: '테크노관', x: 51.45, y: 28.21, category: 'lecture',
      tags: ['강의동', 'ㅌ자 구조', '테크노 도서관'], desc: '이전 후 가장 먼저 지어진 강의동. 미로 같은 ㅌ자 구조로 유명합니다.' },
    { id: 'digital', num: 3, legendName: '디지털관', name: '디지털관', x: 65.82, y: 22.17, category: 'lecture',
      tags: ['강의동', 'ㄷ자 구조', '지하 쉼터'], desc: '전자·컴퓨터공학부 거점 강의동. 도서관 앞까지 이어지는 단풍길이 있습니다.' },
    { id: 'global', num: 4, legendName: '글로벌관', name: '글로벌관', x: 48.73, y: 20.65, category: 'lecture',
      tags: ['강의동', '9층 하늘마당', '야경'], desc: '캠퍼스에서 가장 높은 9층 강의동. 하늘마당 전망대에서 야경을 볼 수 있습니다.',
      spot: { dwell: 5, tags: ['nightview', 'view', 'indoor'], outdoor: false, times: ['sunset', 'night'], note: '9층 하늘마당에서 캠퍼스 야경 감상' } },
    { id: 'library', num: 5, legendName: '도서관', name: '도서관', x: 62.73, y: 29.72, category: 'library',
      tags: ['실내', '열람실', '1층 카페'], desc: '1층 카페와 열람실이 있는 중앙 도서관. 앞에는 분수대 조형물이 있습니다.',
      spot: { dwell: 4, tags: ['indoor', 'quiet', 'cafe'], outdoor: false, note: '1층 로비·카페에서 잠깐 쉬어가기' } },
    { id: 'studentHall', num: 6, legendName: '학생회관', name: '학생회관', x: 68.18, y: 35.77, category: 'welfare',
      tags: ['식당', '편의점', '북카페·소극장'], desc: '학식·편의점·북카페가 모인 편의시설의 중심. 옆에 학생 소극장이 있습니다.',
      spot: { dwell: 5, tags: ['indoor', 'cafe', 'food', 'theater'], outdoor: false, note: '북카페·학생 소극장 앞에서 쉬어가기' } },
    { id: 'dorm', num: 7, legendName: '생활관', name: '생활관(오름관)', x: 35.45, y: 21.41, category: 'dorm',
      tags: ['푸름관·오름관', '오르막', '벚꽃 도로길'], desc: '푸름관·오름관 기숙사. 오름관 옆 도로는 봄밤 벚꽃길로 유명합니다.',
      spot: { dwell: 3, tags: ['cherry', 'view'], outdoor: true, seasons: ['spring'], note: '오름관 옆 벚꽃 도로길 산책' } },
    { id: 'tennis', num: 8, legendName: '테니스장', name: '테니스장', x: 15.45, y: 23.93, category: 'sport',
      tags: ['야외', '체육', '야간조명'], desc: '대운동장 인근 테니스장.',
      spot: { dwell: 2, tags: ['open', 'sport'], outdoor: true, field: true, note: '코트 옆 벤치에서 구경' } },
    { id: 'stadium', num: 9, legendName: '대운동장', name: '대운동장', x: 11.82, y: 35.77, category: 'sport',
      tags: ['트랙', '축구장', '야간조명'], desc: '축구장·육상 트랙이 있는 대운동장. 야간 조명 시설이 있습니다.',
      spot: { dwell: 3, tags: ['open', 'sport', 'view'], outdoor: true, field: true, note: '트랙 반 바퀴 가볍게 걷기' } },
    { id: 'gym', num: 10, legendName: '체육관', name: '체육관', x: 19.09, y: 45.34, category: 'sport',
      tags: ['실내', '헬스장', '암벽등반'], desc: '헬스장·탁구장·대강당이 있는 실내 체육관.',
      spot: { dwell: 3, tags: ['indoor', 'sport'], outdoor: false, note: '실내 로비에서 스트레칭' } },
    { id: 'rotc', num: 11, legendName: '학군단', name: '학군단', x: 25.09, y: 47.36, category: 'admin',
      tags: ['ROTC'], desc: '체육관 우측에 있는 학군단.' },
    { id: 'golf', num: 12, legendName: '골프학습관', name: '골프학습관', x: 32.36, y: 47.86, category: 'sport',
      tags: ['교양 골프 수업'], desc: '학군단 우측의 골프학습관. 교양 골프 수업이 열립니다.' },
    { id: 'multiField', num: 13, legendName: '다목적운동장', name: '다목적운동장', x: 54.18, y: 13.10, category: 'sport',
      tags: ['야외', '운동장'], desc: '캠퍼스 북쪽의 다목적운동장.',
      spot: { dwell: 2, tags: ['open', 'sport'], outdoor: true, field: true, note: '운동장 가장자리 한 바퀴' } },
    { id: 'greenEnergy', num: 14, legendName: '그린에너지관', name: '그린에너지관', x: 67.27, y: 13.10, category: 'research',
      tags: ['연구동'], desc: '북측 연구동.' },
    { id: 'cooperation', num: 15, legendName: '대외협력관', name: '대외협력관', x: 78.73, y: 14.61, category: 'admin',
      tags: ['산학협력', '오르막'], desc: '산학협력 관련 기관이 있는 건물. 북동쪽 오르막 끝에 있습니다.' },
    { id: 'windTunnel', num: 16, legendName: '풍동실험실', name: '풍동실험실', x: 73.45, y: 32.24, category: 'research',
      tags: ['실험동', '도서관 주차장 우측 도로'], desc: '풍동 실험 시설. 도서관 주차장 우측 도로변에 있습니다.' },
    { id: 'eos', num: 17, legendName: '이오스관', name: '이오스관', x: 25.45, y: 18.89, category: 'dorm',
      tags: ['생활관 인근'], desc: '생활관 서쪽 건물.' },
    { id: 'lounge', num: 18, legendName: 'kit라운지', name: 'kit라운지', x: 57.82, y: 43.32, category: 'cafe',
      tags: ['카페', '휴게', '실내'], desc: '테이크아웃 음료와 휴식 공간이 있는 라운지.',
      spot: { dwell: 7, tags: ['indoor', 'cafe', 'rest'], outdoor: false, note: '카페에서 테이크아웃 후 출발' } },
    { id: 'amphi', num: 19, legendName: '야외음악당', name: '야외음악당', x: 91.82, y: 52.39, category: 'outdoor',
      tags: ['야외공연장', '공연동아리', '계단식 좌석'], desc: '축제 공연이 열리는 야외공연장. 공연 동아리방이 모여 있습니다.',
      spot: { dwell: 3, tags: ['view', 'open'], outdoor: true, note: '계단식 좌석에서 잠깐 쉬기' } },
    { id: 'pond', num: 20, legendName: '금오지', name: '금오지', x: 86.00, y: 60.45, category: 'water',
      tags: ['호수', '수변 산책로', '본관 반영'], desc: '본관이 물에 비치는 캠퍼스 연못. 사계절 조용한 산책 명소입니다.',
      spot: { dwell: 4, tags: ['water', 'view', 'open', 'quiet'], outdoor: true, note: '수변 산책로 한 바퀴' } },
    { id: 'gate', num: 21, legendName: '정문', name: '정문', x: 87.64, y: 65.99, category: 'gate',
      tags: ['황금까마귀 조형', '야간 조명', '버스정류장'], desc: '황금까마귀를 형상화한 정문. 밤에는 kit 로고와 교명비에 조명이 켜집니다.' }
  ];

  /* 범례 외 보조 노드: 도서관 앞 분수대·숲길 쉼터(스팟)와 보행 교차점(junction) */
  var WAYPOINTS = [
    { id: 'fountain', name: '도서관 앞 분수대', x: 64.73, y: 37.78, category: 'fountain', minor: true, badge: '분',
      tags: ['DNA 나선 조형물', '여름 분수 가동', '단풍'], desc: '2008년 교내 공모전으로 만든 DNA 나선·원자모형 조형물. 여름에는 주변 연못에서 분수가 솟습니다.',
      spot: { dwell: 3, tags: ['fountain', 'view'], outdoor: true, note: '분수대 조형물 앞 벤치에서 쉬기' } },
    { id: 'forest', name: '숲길 쉼터', x: 42.73, y: 42.32, category: 'forest', minor: true, badge: '숲',
      tags: ['캠퍼스 숲길', '그늘'], desc: '캠퍼스 중앙 숲길 쉼터. 조명이 거의 없어 야간에는 비추천입니다.',
      spot: { dwell: 3, tags: ['forest', 'shade', 'view'], outdoor: true, unpaved: true, note: '중앙 숲길 벤치에서 산림욕' } },
    { id: 'jGateIn',    name: '정문 안쪽 삼거리',   x: 82.18, y: 60.45, junction: true },
    { id: 'jRound',     name: '본관 앞 회전교차로', x: 74.18, y: 53.40, junction: true },
    { id: 'jAmphiPath', name: '음악당 입구',        x: 84.00, y: 53.90, junction: true },
    { id: 'jEastMid',   name: '동측 순환도로',      x: 72.18, y: 35.26, junction: true },
    { id: 'jNorth',     name: '북측 삼거리',        x: 73.09, y: 16.62, junction: true },
    { id: 'jTopW',      name: '다목적운동장 앞길',  x: 58.55, y: 17.13, junction: true },
    { id: 'jCenter',    name: '중앙 광장',          x: 64.00, y: 40.30, junction: true },
    { id: 'jSouth',     name: '남측 사거리',        x: 55.45, y: 51.13, junction: true },
    { id: 'jDiag',      name: '중앙 사선로',        x: 47.64, y: 37.28, junction: true },
    { id: 'jNW',        name: '오름관 입구',        x: 42.73, y: 26.45, junction: true },
    { id: 'jForestTop', name: '숲 북측 도로',       x: 32.73, y: 28.97, junction: true },
    { id: 'jTrackE',    name: '운동장 동측',        x: 21.82, y: 35.26, junction: true },
    { id: 'jGymRd',     name: '체육관 앞길',        x: 20.91, y: 42.32, junction: true },
    { id: 'jSouthW',    name: '숲 남측 도로',       x: 39.09, y: 59.45, junction: true }
  ];

  /*
   * 구간 유형별 기본 환경 속성 (0~1)
   *  open 개방, shade 그늘, covered 처마·실내 인접, water 수변, forest 숲, unpaved 흙길, lit 야간 조명
   */
  var EDGE_TYPES = {
    road:     { label: '보도(차도 옆)',    env: { open: 1.0, shade: 0.2, covered: 0.0, water: 0, forest: 0, unpaved: 0, lit: 0.8 } },
    path:     { label: '교내 보행로',      env: { open: 0.8, shade: 0.4, covered: 0.1, water: 0, forest: 0, unpaved: 0, lit: 0.6 } },
    arcade:   { label: '건물 인접·처마길', env: { open: 0.2, shade: 0.7, covered: 0.9, water: 0, forest: 0, unpaved: 0, lit: 0.9 } },
    forest:   { label: '숲길',             env: { open: 0.2, shade: 0.9, covered: 0.0, water: 0, forest: 1, unpaved: 1, lit: 0.05 } },
    lakeside: { label: '금오지 수변길',    env: { open: 0.9, shade: 0.3, covered: 0.0, water: 1, forest: 0, unpaved: 0, lit: 0.4 } },
    track:    { label: '운동장 트랙',      env: { open: 1.0, shade: 0.0, covered: 0.0, water: 0, forest: 0, unpaved: 1, lit: 0.5 } }
  };

  /*
   * 계절·시간대 특화 구간 태그(features)
   *  cherry   봄 벚꽃 (오름관 옆 도로길, 본관 벚꽃 가로수)
   *  maple    가을 단풍 (도서관 앞 ~ 디지털관)
   *  nightLit 야간 조명 코스 (글로벌관·도서관·학생회관 소극장 중심 동선, 정문 진입로)
   */
  var FEATURES = {
    cherry:   { label: '벚꽃길',        color: '#f06aa0', season: 'spring' },
    maple:    { label: '단풍길',        color: '#e0702a', season: 'autumn' },
    nightLit: { label: '야간 조명 코스', color: '#ffdd00', time: 'night' }
  };

  // [노드A, 노드B, 유형, 난이도(flat|hill|stairs), 환경 덮어쓰기({..., features:[]}), 메모]
  var EDGES = [
    ['gate', 'jGateIn', 'road', 'flat', { lit: 1, features: ['nightLit'] }, '정문 진입로(야간 조명)'],
    ['jGateIn', 'jRound', 'road', 'flat', { features: ['cherry', 'nightLit'] }, '정문→본관 앞 벚꽃 가로수'],
    ['jGateIn', 'pond', 'lakeside', 'flat'],
    ['pond', 'amphi', 'lakeside', 'flat', { shade: 0.4 }, '금오지 수변길'],
    ['amphi', 'jAmphiPath', 'lakeside', 'flat', { shade: 0.5, water: 0.6 }],
    ['jAmphiPath', 'pond', 'lakeside', 'flat'],
    ['jAmphiPath', 'jRound', 'path', 'flat', null, '주차장 옆 보행로'],
    ['jRound', 'main', 'road', 'flat', { lit: 0.9, features: ['cherry', 'nightLit'] }, '본관 벚꽃 가로수'],
    ['jRound', 'jEastMid', 'road', 'hill', null, '동측 순환도로 오르막'],
    ['jRound', 'jCenter', 'path', 'flat', { shade: 0.5 }, '잔디 광장 보행로'],
    ['jEastMid', 'studentHall', 'arcade', 'flat'],
    ['jEastMid', 'windTunnel', 'road', 'flat', { lit: 0.6 }, '도서관 주차장 우측 도로'],
    ['jEastMid', 'jNorth', 'road', 'hill'],
    ['jNorth', 'cooperation', 'road', 'hill', { lit: 0.5 }, '대외협력관 오르막'],
    ['jNorth', 'greenEnergy', 'road', 'flat'],
    ['jNorth', 'digital', 'path', 'flat'],
    ['greenEnergy', 'jTopW', 'path', 'flat'],
    ['jTopW', 'multiField', 'path', 'flat'],
    ['jTopW', 'digital', 'path', 'flat'],
    ['jTopW', 'global', 'path', 'stairs'],
    ['digital', 'library', 'arcade', 'flat', { shade: 0.8, features: ['maple'] }, '도서관 앞~디지털관 단풍길'],
    ['library', 'fountain', 'path', 'flat', { shade: 0.5, lit: 0.9, features: ['maple', 'nightLit'] }, '도서관 앞 분수대'],
    ['fountain', 'jCenter', 'path', 'flat', { lit: 0.9, features: ['nightLit'] }],
    ['library', 'studentHall', 'arcade', 'flat', { features: ['nightLit'] }, '도서관-학생회관 중심 동선'],
    ['library', 'techno', 'arcade', 'flat', { features: ['nightLit'] }, '중심 동선'],
    ['library', 'jCenter', 'arcade', 'flat'],
    ['studentHall', 'jCenter', 'arcade', 'flat', { features: ['nightLit'] }, '학생 소극장·북카페 앞'],
    ['jCenter', 'lounge', 'arcade', 'flat', { features: ['nightLit'] }, '광장→kit라운지'],
    ['lounge', 'jSouth', 'path', 'flat'],
    ['lounge', 'techno', 'path', 'flat', { covered: 0.3 }],
    ['lounge', 'main', 'path', 'flat', { shade: 0.5 }],
    ['main', 'jSouth', 'road', 'flat', { features: ['cherry'] }, '본관 옆 벚꽃 가로수'],
    ['jSouth', 'jDiag', 'road', 'hill', { shade: 0.5, lit: 0.6 }, '숲 가장자리 사선로'],
    ['jDiag', 'techno', 'road', 'flat'],
    ['jDiag', 'jNW', 'road', 'hill'],
    ['global', 'techno', 'arcade', 'flat', { features: ['nightLit'] }, '글로벌관-테크노관 조명 동선'],
    ['global', 'jNW', 'road', 'flat', { features: ['nightLit'] }],
    ['jNW', 'dorm', 'road', 'hill', { lit: 0.9, features: ['cherry'] }, '오름관 옆 벚꽃 도로길'],
    ['dorm', 'eos', 'path', 'stairs'],
    ['eos', 'tennis', 'path', 'hill', { shade: 0.5, lit: 0.4 }],
    ['jNW', 'jForestTop', 'road', 'flat', { shade: 0.5, features: ['cherry'] }, '생활관 앞 벚꽃 도로'],
    ['jForestTop', 'jTrackE', 'road', 'flat', { shade: 0.4, lit: 0.5 }],
    ['jTrackE', 'tennis', 'path', 'flat'],
    ['jTrackE', 'stadium', 'track', 'flat'],
    ['jTrackE', 'jGymRd', 'road', 'flat'],
    ['jGymRd', 'stadium', 'track', 'flat'],
    ['jGymRd', 'gym', 'road', 'flat'],
    ['gym', 'rotc', 'road', 'flat'],
    ['rotc', 'golf', 'path', 'flat', { lit: 0.4 }],
    ['rotc', 'jSouthW', 'road', 'flat', { shade: 0.4, lit: 0.3 }, '외곽 도로'],
    ['golf', 'jSouthW', 'path', 'flat', { shade: 0.5, lit: 0.3 }],
    ['jSouthW', 'jSouth', 'road', 'flat', { shade: 0.5, lit: 0.3 }, '숲 남측 외곽 도로'],
    ['forest', 'jForestTop', 'forest', 'hill', null, '캠퍼스 숲길(북)'],
    ['forest', 'jDiag', 'forest', 'flat', null, '캠퍼스 숲길(동)'],
    ['forest', 'golf', 'forest', 'hill', null, '캠퍼스 숲길(서)'],
    ['forest', 'jSouthW', 'forest', 'flat', null, '캠퍼스 숲길(남)']
  ];

  /* 대표 산책 테마 */
  var THEMES = [
    { id: 'auto',   label: '자동(상황 맞춤)', desc: '날씨·계절·시간대에 가장 잘 맞는 코스를 우선합니다.', routeWeights: {}, spotWeights: {} },
    { id: 'nature', label: '호수·자연 힐링', desc: '금오지 수변길, 숲길, 야외음악당 위주',
      routeWeights: { water: 8, forest: 7, shade: 2 }, spotWeights: { water: 6, forest: 6, view: 4 } },
    { id: 'seasonal', label: '계절·야경 명소', desc: '벚꽃길·분수대·단풍길·글로벌관 야경 등 지금만 볼 수 있는 풍경',
      routeWeights: {}, spotWeights: { cherry: 6, fountain: 5, nightview: 6, theater: 3 }, featureWeights: { cherry: 4, maple: 4, nightLit: 2 } },
    { id: 'indoor', label: '실내·건물 인접(우천 회피)', desc: '처마·건물 인접 동선과 실내 경유지 위주',
      routeWeights: { covered: 10, open: -3 }, spotWeights: { indoor: 6, cafe: 2 } },
    { id: 'cafe',   label: '카페·휴식 경유', desc: 'kit라운지·학생회관 북카페·도서관 카페에서 쉬어가기',
      routeWeights: { covered: 3 }, spotWeights: { cafe: 9, rest: 4, food: 3, theater: 2 } },
    { id: 'active', label: '가볍게 운동', desc: '운동장·트랙을 포함한 활동적인 코스',
      routeWeights: { open: 2 }, spotWeights: { sport: 7, open: 2 } }
  ];

  return { MAP: MAP, LANDMARKS: LANDMARKS, WAYPOINTS: WAYPOINTS, EDGE_TYPES: EDGE_TYPES, FEATURES: FEATURES, EDGES: EDGES, THEMES: THEMES };
});
