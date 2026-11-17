-- UGCS 로컬 영속 스키마 (SQLite, WAL 모드)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 운용자 계정 (PIN은 PBKDF2-SHA256 해시로만 저장)
CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('PILOT','MISSION_CTRL','MAINTENANCE','OBSERVER')),
    pin_hash     TEXT NOT NULL,
    salt         TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);

-- 단일 제어권 상태 (행 1개)
CREATE TABLE IF NOT EXISTS control_lock (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    holder_id   INTEGER REFERENCES users(id),
    acquired_at REAL
);

-- 기체 및 가용 상태
CREATE TABLE IF NOT EXISTS aircraft (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    model          TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('AIRWORTHY','MAINTENANCE_REQUIRED','GROUNDED')),
    total_flight_s REAL NOT NULL DEFAULT 0,
    updated_at     REAL NOT NULL
);

-- 공역/지형 정보: NFZ(금지구역), GEOFENCE(기본 허용구역), TERRAIN(지형 표시용)
CREATE TABLE IF NOT EXISTS zones (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    kind     TEXT NOT NULL CHECK (kind IN ('NFZ','GEOFENCE','TERRAIN')),
    name     TEXT NOT NULL,
    geometry TEXT NOT NULL,   -- JSON [[lat,lon],...]
    props    TEXT NOT NULL DEFAULT '{}'
);

-- 임무 계획
CREATE TABLE IF NOT EXISTS missions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    aircraft_id TEXT NOT NULL REFERENCES aircraft(id),
    waypoints   TEXT NOT NULL,          -- JSON [{lat,lon,alt,speed,hold,action}]
    geofence    TEXT,                   -- JSON [[lat,lon],...] | NULL(기본 지오펜스 사용)
    home        TEXT,                   -- JSON {lat,lon}
    version     INTEGER NOT NULL DEFAULT 1,
    status      TEXT NOT NULL CHECK (status IN ('DRAFT','READY','UPLOADED','ARCHIVED')),
    last_plan   TEXT,                   -- 마지막 경로 계산/검증 결과 JSON
    created_by  INTEGER REFERENCES users(id),
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

-- 비행 세션
CREATE TABLE IF NOT EXISTS flights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    aircraft_id TEXT NOT NULL REFERENCES aircraft(id),
    mission_id  INTEGER REFERENCES missions(id),
    operator_id INTEGER REFERENCES users(id),
    started_at  REAL NOT NULL,
    ended_at    REAL,
    distance_m  REAL NOT NULL DEFAULT 0,
    max_alt_m   REAL NOT NULL DEFAULT 0,
    end_reason  TEXT
);

-- 시계열 텔레메트리 스냅샷 (재생용)
CREATE TABLE IF NOT EXISTS telemetry (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL REFERENCES flights(id),
    t         REAL NOT NULL,
    data      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_telemetry_flight ON telemetry(flight_id, t);

-- 경보 이력 (발생/인지/해제)
CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id  INTEGER REFERENCES flights(id),
    code       TEXT NOT NULL,
    severity   TEXT NOT NULL CHECK (severity IN ('CRITICAL','WARNING','INFO')),
    message    TEXT NOT NULL,
    cause      TEXT NOT NULL DEFAULT '',
    raised_at  REAL NOT NULL,
    acked_at   REAL,
    acked_by   INTEGER REFERENCES users(id),
    cleared_at REAL,
    latched    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_alerts_open ON alerts(cleared_at);

-- 정비 이력
CREATE TABLE IF NOT EXISTS maintenance (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    aircraft_id   TEXT NOT NULL REFERENCES aircraft(id),
    date          TEXT NOT NULL,
    technician    TEXT NOT NULL,
    mtype         TEXT NOT NULL CHECK (mtype IN ('정기점검','수리','부품교체')),
    checklist     TEXT NOT NULL DEFAULT '[]',   -- JSON [{item, ok}]
    notes         TEXT NOT NULL DEFAULT '',
    result_status TEXT NOT NULL CHECK (result_status IN ('AIRWORTHY','MAINTENANCE_REQUIRED','GROUNDED')),
    created_by    INTEGER REFERENCES users(id),
    created_at    REAL NOT NULL
);

-- 감사 로그 (허용/거부 모두 기록, 삭제 API 없음)
CREATE TABLE IF NOT EXISTS audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    t        REAL NOT NULL,
    user_id  INTEGER,
    username TEXT,
    role     TEXT,
    action   TEXT NOT NULL,
    target   TEXT,
    result   TEXT NOT NULL CHECK (result IN ('ALLOWED','DENIED','ERROR')),
    detail   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_audit_t ON audit(t);
