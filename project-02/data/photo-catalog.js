/*
 * KIT 공강 산책 — 실사 사진 카탈로그 (11장) + 캠퍼스맵·인트로 자산
 * ------------------------------------------------------------
 *  file            project-02/ 안의 실제 파일명(한글·공백·괄호 포함, 이름 변경 금지 → 화면에서는 encodeURI로 참조)
 *  nodes           매핑된 노드 ID (campus-data.js). 'campus'는 캠퍼스 전경(특정 지점 없음)
 *  seasons         spring | summer | autumn | winter | all
 *  times           day | sunset | night | all
 *  fountainActive  분수대 사진만 true/false (그 외 null)
 *  caption         한 줄 설명
 */
(function (root, factory) {
  var data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.KITWalkPhotos = data;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PHOTOS = [
    { id: 'overview', file: 'KakaoTalk_20261116_200729883_02.webp', nodes: ['campus'], seasons: ['all'], times: ['day'], fountainActive: null,
      overview: true, w: 960, h: 640, caption: '낮의 양호동 캠퍼스 전경 — 금오산 자락 아래 강의동과 잔디광장' },
    { id: 'globalNight', file: '금오공대 글로벌관 옥상 야경.jpg', nodes: ['global'], seasons: ['all'], times: ['night'], fountainActive: null,
      w: 2421, h: 1816, caption: '글로벌관 9층 하늘마당에서 내려다본 캠퍼스 야경' },
    { id: 'library', file: '금오공대 도서관.jpg', nodes: ['library'], seasons: ['spring', 'summer', 'autumn'], times: ['day'], fountainActive: null,
      w: 4824, h: 3618, caption: '잔디밭 너머 유리 외관의 중앙 도서관' },
    { id: 'cherryNight', file: '금오공대 벗꽃.jpg', nodes: ['dorm'], seasons: ['spring'], times: ['night', 'sunset'], fountainActive: null,
      w: 2624, h: 3936, caption: '가로등 아래 벚꽃 터널 — 봄밤 오름관 옆 도로길' },
    { id: 'fountainOn', file: '금오공대 분수대 작동 모습.webp', nodes: ['fountain', 'library'], seasons: ['summer'], times: ['day'], fountainActive: true,
      w: 628, h: 399, caption: '물줄기가 솟는 도서관 앞 DNA 나선 분수대(가동 중)' },
    { id: 'fountainOff', file: '금오공대 분수대.webp', nodes: ['fountain', 'library'], seasons: ['spring', 'autumn', 'winter'], times: ['day'], fountainActive: false,
      w: 500, h: 465, caption: '분수가 멈춘 계절의 DNA 나선·원자모형 조형물' },
    { id: 'gate', file: '금오공대 정문.webp', nodes: ['gate'], seasons: ['all'], times: ['day'], fountainActive: null,
      w: 438, h: 252, caption: '황금까마귀 날개를 형상화한 kit 정문' },
    { id: 'theater', file: '금오공대 학생회관 옆 학생 소극장.jpg', nodes: ['studentHall'], seasons: ['all'], times: ['sunset'], fountainActive: null,
      w: 2728, h: 4092, caption: '노을빛이 내려앉은 학생회관 옆 학생 소극장' },
    { id: 'autumnRoad', file: '금오공대의 가을.jpg', nodes: ['digital', 'library'], seasons: ['autumn'], times: ['day'], fountainActive: null,
      w: 2731, h: 4096, caption: '도서관 앞에서 디지털관으로 이어지는 가을 산책길' },
    { id: 'mainCherry', file: '금오공대의 본관.webp', nodes: ['main'], seasons: ['spring'], times: ['day'], fountainActive: null,
      w: 1098, h: 933, caption: '벚꽃 가로수가 만개한 본관(대학본부)' },
    { id: 'pond', file: '금오지(금오공대 연못).jpg', nodes: ['pond', 'main'], seasons: ['all'], times: ['day'], fountainActive: null,
      w: 2851, h: 4276, caption: '본관이 비치는 고요한 금오지 수변' }
  ];

  var ASSETS = {
    campusMap: { file: 'kumoh_ac_kr_20120125_164421.jpg', caption: '금오공과대학교 캠퍼스 안내도(기본 지도)' },
    intro: { file: '웹사이트 인트로.gif', durationMs: 3200, caption: '웹사이트 인트로 애니메이션' }
  };

  return { PHOTOS: PHOTOS, ASSETS: ASSETS };
});
