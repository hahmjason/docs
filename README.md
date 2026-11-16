# Docs — 프로젝트 아카이브

이 저장소(`hahmjason/docs`)는 여러 웹 애플리케이션과 미니 프로젝트를 순서대로 정리·보관하는 멀티 프로젝트 저장소입니다.  
각 프로젝트는 루트 아래의 `project-N/` 폴더 단위로 관리되며, 폴더 내부의 `README.md`에서 상세 기능과 실행 방법을 확인할 수 있습니다.

## 프로젝트 목록

| 번호 | 프로젝트 | 설명 | 바로가기 |
| :--- | :--- | :--- | :--- |
| **Project 1** | **동아리 매니저** (`project-1`) | 공지사항, 일정·출석, 회원 명단, 회비·장부를 한곳에서 관리하는 순수 HTML/CSS/JS 웹 앱 | [소개 문서](./project-1/README.md) · [폴더](./project-1/) · [분리 버전 (`index.html`)](./project-1/club-manager/index.html) · [단일 파일 (`club-manager.html`)](./project-1/club-manager.html) |

> 새로운 프로젝트가 추가될 때마다 `project-2/`, `project-3/` 형태로 폴더가 생성되고 위 목록에 추가됩니다.

## 저장소 구조

```text
.
├── README.md                  # 저장소 전체 안내 및 프로젝트 목록
└── project-1/                 # Project 1: 동아리 매니저
    ├── README.md              # Project 1 상세 소개
    ├── club-manager.html      # 단일 HTML 번들 버전
    └── club-manager/          # HTML / CSS / JS 분리 버전
        ├── index.html
        ├── style.css
        └── app.js
```
