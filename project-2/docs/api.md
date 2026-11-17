# UGCS REST / SSE API

- 기본 주소: `http://<차량 서버 IP>:8080`
- 요청과 응답 본문은 JSON(UTF-8)입니다. 오류 응답 형식은 `{"error": "<코드>", "message": "<설명>"}`입니다.
- 인증은 `POST /api/auth/login`으로 받은 토큰을 사용합니다. HttpOnly 쿠키 `ugcs_token`(브라우저) 또는 `Authorization: Bearer <token>` 헤더로 보냅니다.
- 미인증 요청은 `401`, 권한 부족이나 제어권 미보유는 `403`을 반환합니다. 두 경우 모두 감사 로그에 `DENIED`로 남습니다.

| 상태 | 의미 |
| :--- | :--- |
| 400 | 입력 형식 오류 |
| 401 | 로그인 필요 / PIN 불일치 |
| 403 | `ROLE_DENIED`(역할 권한 없음), `NO_CONTROL`(제어권 미보유), `FORCE_DENIED`, `NOT_HOLDER` |
| 404 | 대상 없음 |
| 409 | `LOCK_HELD`, `AIRCRAFT_NOT_AIRWORTHY`, `PLAN_INVALID`, `MISSION_NOT_READY`, `VEHICLE_DENIED`(기체 NACK), 상태 전이 불가 |
| 428 | `CONFIRM_REQUIRED` — 위험 명령 2차 확인 토큰 누락 |
| 504 | `LINK_TIMEOUT` — 재전송 후에도 기체 ACK 없음 |

## 인프라

| 메서드 | 경로 | 권한 | 설명 |
| :--- | :--- | :--- | :--- |
| GET | `/health` | 없음 | `{status, version, uptime_s, db:{ok,path,schema}, datalink:{adapter,connected,hb_age_s}, loop_running, network:"local-only"}` — 정상 200 / 이상 503 |
| GET | `/` , `/css/*`, `/js/*`, `/assets/*` | 없음 | 조종 콘솔 정적 리소스 (CSP `default-src 'self'`) |
| GET | `/api/stream` | `state.read` | SSE. 이벤트: `state`(5 Hz 전체 상태), `alert`(발생·해제·인지), `control`, `flight`(시작·종료) |

## 인증 · 제어권

| 메서드 | 경로 | 권한 | 본문 / 비고 |
| :--- | :--- | :--- | :--- |
| GET | `/api/users` | 없음 | 로그인 화면용 운용자 목록 (PIN 정보 제외) |
| POST | `/api/auth/login` | 없음 | `{username, pin}` → `{token, user}` |
| POST | `/api/auth/logout` | 로그인 | 세션 삭제 |
| GET | `/api/auth/me` | `state.read` | 현재 사용자와 권한 목록 |
| GET | `/api/control` | `state.read` | 제어권 보유자 |
| POST | `/api/control/acquire` | `control.acquire` | `{force?: bool}` — 다른 사람이 보유 중이면 409. `force`는 `control.force`(임무통제관)만 가능 |
| POST | `/api/control/release` | 보유자 | 제어권 이양(해제) |

## 비행 제어 명령 (역할 권한 + 제어권 필수)

`POST /api/commands/{COMMAND}`

| COMMAND | 본문 | 비고 |
| :--- | :--- | :--- |
| `TAKEOFF` | `{alt}` | 5~150 m. 기체 상태가 AIRWORTHY가 아니면 409와 `GROUNDED_TAKEOFF` 경보 |
| `UPLOAD_MISSION` | `{mission_id}` | READY 임무만 가능. 서버가 경로를 다시 검증한 뒤 COUNT/ITEM/ACK 절차로 업로드하고 상태를 UPLOADED로 바꿈 |
| `START_MISSION` | — | 업로드된 임무가 필요. 지상에 있으면 자동 이륙 후 시작. 정비 불가 기체는 차단 |
| `PAUSE` / `RESUME` | — | 현 위치 정지비행 / 다음 WP부터 재개 |
| `RTL` | `{confirm:"RTL"}` | 위험 명령 — 확인 토큰 필수 |
| `LAND` | `{confirm:"LAND"}` | 위험 명령 |
| `ESTOP` | `{confirm:"ESTOP"}` | 위험 명령 — 모터 정지 |
| `GIMBAL` | `{pitch, yaw}` | 짐벌 각도 |

응답은 `{command, ack:{ok, result, message, attempts, rtt_ms}}`입니다.

## 임무 계획

| 메서드 | 경로 | 권한 | 설명 |
| :--- | :--- | :--- | :--- |
| POST | `/api/route/compute` | `mission.read` | `{home?, waypoints, geofence?, start_battery_pct?}` → 경로 계산·검증 결과 (저장 안 함) |
| GET | `/api/missions` | `mission.read` | `?archived=0`이면 보관 임무 제외 |
| POST | `/api/missions` | `mission.write` | `{name, aircraft_id, waypoints:[{lat,lon,alt,speed,hold,action}], geofence?, home?}` |
| GET / PUT / DELETE | `/api/missions/{id}` | 조회 / `mission.write` | PUT은 버전을 올리고 DRAFT로 되돌림. UPLOADED 임무와 비행 기록이 있는 임무는 삭제 불가 |
| POST | `/api/missions/{id}/validate` | `mission.read` | 현재 공역과 배터리 기준으로 검증하고 결과(`last_plan`) 저장 |
| POST | `/api/missions/{id}/status` | 상태별 | `{status}` — READY는 `mission.approve` + 검증 통과, ARCHIVED는 `mission.archive`, DRAFT는 `mission.write`. UPLOADED는 명령으로만 설정 |

경로 계산 결과 형식:

```json
{
  "ok": true,
  "total_distance_m": 3670.2, "total_distance_3d_m": 3681.5, "total_time_s": 417.0,
  "energy_pct": 20.5, "battery_start_pct": 100.0, "battery_end_pct": 79.5,
  "max_alt_m": 80.0, "max_range_m": 1140.0,
  "legs": [{"index":0,"frm":"HOME","to":"WP1","distance_m":671.0,"bearing_deg":27.0,
            "alt_change_m":60.0,"speed_mps":10.0,"time_s":67.1,"hold_s":0,"energy_pct":3.9,"battery_after_pct":96.1}],
  "issues": [{"code":"NFZ_CROSS","severity":"ERROR","message":"구간 2(WP1→WP2)이 금지구역 '탄약고 보호구역'을 통과","index":1}]
}
```

검증 코드: `WP_INVALID`, `NO_WAYPOINTS`, `WP_ACTION`, `MAX_ALT`, `MIN_ALT`, `SPEED`, `HOLD`, `MAX_RANGE`, `RANGE_MARGIN`(주의), `MAX_ROUTE`, `NFZ_CROSS`, `GEOFENCE`, `HOME_OUTSIDE_FENCE`, `BATTERY`, `BATTERY_MARGIN`(주의)

## 상태 · 기체 · 공역

| 메서드 | 경로 | 권한 | 설명 |
| :--- | :--- | :--- | :--- |
| GET | `/api/state` | `state.read` | SSE `state` 이벤트와 같은 스냅샷: `aircraft`, `telemetry`, `link`, `gcs`, `relative`, `control`, `alerts_active`, `flight`, `active_mission_id`, `sim` |
| GET | `/api/zones` | `state.read` | NFZ, 지오펜스, 지형 폴리곤과 통신 반경, 검증 한계, 성능 파라미터 |
| GET | `/api/aircraft` | `state.read` | 기체 목록, 가용 상태, 현재 연결 기체 |
| POST | `/api/aircraft/{id}/select` | 제어권 보유자 | 연결 기체 변경 (지상에서만) |

## 비행 기록 · 경보 · 정비 · 감사

| 메서드 | 경로 | 권한 | 설명 |
| :--- | :--- | :--- | :--- |
| GET | `/api/flights` | `flight.read` | 비행 세션 목록 (스냅샷 수, 경보 수 포함) |
| GET | `/api/flights/{id}` | `flight.read` | 세션 상세와 세션 중 발생한 경보 |
| GET | `/api/flights/{id}/telemetry` | `flight.read` | 1 Hz 시계열 (재생용) |
| GET | `/api/alerts` | `alert.read` | `?active=1`은 활성 경보만, `?limit=` |
| POST | `/api/alerts/{id}/ack` | `alert.ack` | 경보 인지. 이벤트형 경보는 인지하면 해제 |
| GET | `/api/maintenance` | `maint.read` | `?aircraft_id=` |
| POST | `/api/maintenance` | `maint.write` | `{aircraft_id, date, technician, mtype(정기점검/수리/부품교체), checklist:[{item,ok}], notes, result_status}` — 저장하면 기체 가용 상태도 즉시 갱신 |
| GET | `/api/audit` | `audit.read` | `?result=DENIED` 등 필터, `?limit=` |

## 시뮬레이터 (장애 주입)

| 메서드 | 경로 | 권한 | 본문 |
| :--- | :--- | :--- | :--- |
| GET | `/api/sim` | `state.read` | 현재 주입값 |
| POST | `/api/sim` | `sim.control` | `{link_down, latency_ms, loss_pct, corrupt_pct, battery_drain_x, wind_mps, gps_degraded}` 중 일부, 또는 `{action:"battery_drop", pct}` · `{action:"reset"}` · `{action:"move_gcs", lat, lon}` |
