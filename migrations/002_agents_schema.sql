-- =========================
-- 2. 장비 (Agents)
-- =========================

-- 등록된 에이전트 장비
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  thing_name TEXT NOT NULL UNIQUE,         -- AWS IoT Thing 이름
  machine_id TEXT,                          -- 머신 고유 ID (해시)
  certificate_arn TEXT,                     -- AWS 인증서 ARN
  name TEXT NOT NULL DEFAULT '',            -- 사용자 지정 장비 이름
  description TEXT NOT NULL DEFAULT '',     -- 장비 설명
  status TEXT NOT NULL DEFAULT 'offline',   -- online / offline / revoked
  os TEXT NOT NULL DEFAULT '',              -- linux / windows / darwin
  arch TEXT NOT NULL DEFAULT '',            -- amd64 / arm64
  version TEXT NOT NULL DEFAULT '',         -- 에이전트 버전
  last_seen_at INTEGER,                     -- 마지막 통신 시각 (웹훅으로 갱신)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_agents_account_id ON agents(account_id);
CREATE INDEX idx_agents_thing_name ON agents(thing_name);
CREATE INDEX idx_agents_status ON agents(account_id, status);

-- =========================
-- 3. 에이전트 이벤트 로그
-- =========================

-- 에이전트에서 수신한 이벤트 기록 (웹훅 → 여기에 저장)
CREATE TABLE agent_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  account_id TEXT NOT NULL,                -- 조회 최적화용 비정규화
  type TEXT NOT NULL,                       -- status / telemetry / scan / anomaly / response
  data TEXT NOT NULL DEFAULT '{}',          -- JSON (이벤트 페이로드 전체)
  created_at INTEGER NOT NULL,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_events_agent ON agent_events(agent_id, type, created_at DESC);
CREATE INDEX idx_agent_events_account ON agent_events(account_id, created_at DESC);

-- =========================
-- 4. 에이전트 명령 기록
-- =========================

-- 서버 → 에이전트로 전달한 명령 추적
CREATE TABLE agent_commands (
  id TEXT PRIMARY KEY,                      -- UUID (= commandId)
  agent_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  action TEXT NOT NULL,                     -- 명령 타입 (scan_usb, http_request, ping 등)
  params TEXT NOT NULL DEFAULT '{}',        -- JSON (명령 파라미터)
  status TEXT NOT NULL DEFAULT 'pending',   -- pending / delivered / completed / failed / timeout
  exit_code INTEGER,                        -- 실행 결과 코드 (response 수신 시 업데이트)
  result TEXT,                              -- JSON (실행 결과 데이터)
  error TEXT,                               -- 에러 메시지
  created_at INTEGER NOT NULL,              -- 명령 생성 시각
  completed_at INTEGER,                     -- 실행 완료 시각
  timeout_seconds INTEGER NOT NULL DEFAULT 30, -- 타임아웃 (초)

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_commands_agent ON agent_commands(agent_id, status, created_at DESC);
CREATE INDEX idx_agent_commands_account ON agent_commands(account_id, created_at DESC);

-- =========================
-- 5. 장비 등록 토큰
-- =========================

-- 웹 콘솔에서 발급하는 일회용 등록 토큰
CREATE TABLE agent_registration_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,          -- SHA-256 해시 (원본 미저장)
  name TEXT NOT NULL DEFAULT '',            -- 토큰 설명 (어디에 설치할 건지)
  used_by_agent_id TEXT,                    -- 사용된 에이전트 ID (사용 후 설정)
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,

  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (used_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX idx_agent_reg_tokens_account ON agent_registration_tokens(account_id);
CREATE INDEX idx_agent_reg_tokens_hash ON agent_registration_tokens(token_hash);
