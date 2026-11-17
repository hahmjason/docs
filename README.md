# Docs — 프로젝트 아카이브

이 저장소(`hahmjason/docs`)는 여러 웹 애플리케이션과 미니 프로젝트를 순서대로 정리·보관하는 멀티 프로젝트 저장소입니다.  
각 프로젝트는 루트 아래의 `project-N/` 폴더 단위로 관리되며, 폴더 내부의 `README.md`에서 상세 기능과 실행 방법을 확인할 수 있습니다.

## 프로젝트 목록

> 🌐 **Project 02 웹사이트:** https://hahmjason.github.io/docs/project-02/#plan

| 번호 | 프로젝트 | 설명 | 바로가기 |
| :--- | :--- | :--- | :--- |
| **Project 1** | **동아리 매니저** (`project-1`) | 공지사항, 일정·출석, 회원 명단, 회비·장부를 한곳에서 관리하는 순수 HTML/CSS/JS 웹 앱 | [소개 문서](./project-1/README.md) · [폴더](./project-1/) · [분리 버전 (`index.html`)](./project-1/club-manager/index.html) · [단일 파일 (`club-manager.html`)](./project-1/club-manager.html) |
| **Project 02** | **KIT 공강 산책 코스** (`project-02`) | 출발 건물·다음 수업 건물·남은 공강 시간과 **날씨·계절·시간대(낮/저녁/야간)**를 반영해, 다음 수업에 늦지 않고 다녀올 수 있는 금오공대 교내 산책 코스 TOP 3를 추천하는 순수 HTML/CSS/JS 웹 앱. 캠퍼스 지도에 동선과 벚꽃길·단풍길·야간 조명 구간을 표시하고, 상황에 맞는 실제 캠퍼스 사진 11장을 보여 줍니다. (GIF 인트로, 시간표 연동, 산책 타이머, 상황 시뮬레이터) | **[🌐 웹사이트 바로가기](https://hahmjason.github.io/docs/project-02/#plan)** · [소개·사용법](./project-02/README.md) · [폴더](./project-02/) · [앱 실행 (`index.html`)](./project-02/index.html) · [로직 테스트](./project-02/tests/index.html) |
| **Project 3** | **금오정밀 수주·납품 관리 Back-office** (`project-3`) | 2회차 실습. 한 장 설계도(PRD)와 1번 화면 구현 — 기준정보(품번 12종·발주처 8곳) 기반으로 수주를 **접수·검증·집계·승인·기록**하는 단일 HTML 워크스페이스. `KJH2201` 같은 오표기를 자동 정규화해 `KJ-H2201` 90+57 → **147** 단일 품목으로 통합 집계 | [🌐 1번 화면](https://hahmjason.github.io/docs/project-3/docs/) · [설계도 (`실습2_PRD.md`)](./project-3/docs/실습2_PRD.md) · [소개](./project-3/README.md) · [앱 (`index.html`)](./project-3/docs/index.html) |

> 새로운 프로젝트가 추가될 때마다 `project-2/`, `project-3/` 형태로 폴더가 생성되고 위 목록에 추가됩니다.

## 저장소 구조

```text
.
├── README.md                  # 저장소 전체 안내 및 프로젝트 목록
├── project-1/                 # Project 1: 동아리 매니저
│   ├── README.md              # Project 1 상세 소개
│   ├── club-manager.html      # 단일 HTML 번들 버전
│   └── club-manager/          # HTML / CSS / JS 분리 버전
│       ├── index.html
│       ├── style.css
│       └── app.js
├── project-02/                # Project 02: KIT 공강 산책 코스 (날씨·계절·시간대 맞춤 교내 산책 추천)
│   ├── README.md              # 5대 구성요소 설명, 사진 11장 + 캠퍼스맵 활용 방식, 추천 규칙, 실행 방법
│   ├── index.html             # 진입점 (GitHub Pages / file:// 바로 실행, GIF 인트로 포함)
│   ├── style.css              # 반응형 스타일 (KIT-BLUE·KIT-YELLOW 교색)
│   ├── app.js                 # 화면: 인트로, 포토 프리뷰, 지도 SVG 오버레이, 시뮬레이터, 추천 카드, 타이머, 시간표, 기록
│   ├── data/                  # campus-data.js(지점·분수대·보행 연결로·특화 구간) · photo-catalog.js(사진 11장 메타데이터)
│   ├── js/                    # engine.js(경로·추천) · photo-matcher.js(사진 매칭) · context.js(계절·시간대)
│   │                          # · weather.js(Open-Meteo 어댑터) · timetable.js(시간표)
│   ├── screenshots/           # README용 앱 화면 캡처
│   ├── tests/                 # 핵심 로직 검증 테스트 39개 (node tests/run-tests.js 또는 tests/index.html)
│   ├── kumoh_ac_kr_20120125_164421.jpg  # 캠퍼스 안내도(기본 지도)
│   ├── 웹사이트 인트로.gif     # 첫 화면 인트로 애니메이션
│   └── 캠퍼스 사진 11장        # 본관·도서관·분수대(가동/정지)·벚꽃·가을·소극장·글로벌관 야경·금오지·정문·전경
└── project-3/                 # Project 3: 금오정밀 수주·납품 관리 Back-office (2회차 실습)
    ├── README.md              # 시나리오·실행 방법·완료 기준 시연 순서
    └── docs/
        ├── 실습2_PRD.md        # 한 장 설계도 v1 (사용자·목적·화면·데이터·규칙·완료 기준 + 조원 검토표)
        └── index.html         # 1번 화면: 수주 접수·검증·실시간 집계·승인·감사 로그 워크스페이스
```
