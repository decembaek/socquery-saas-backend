-- =========================
-- 6. 에이전트 그룹
-- =========================

CREATE TABLE agent_groups (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_agent_groups_account_name
  ON agent_groups(account_id, name);
CREATE INDEX idx_agent_groups_account_id
  ON agent_groups(account_id);

-- =========================
-- 7. 그룹 규칙/알람/웹훅
-- =========================

CREATE TABLE agent_group_rules (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,                -- cpu, memory, disk, process, network, usb...
  operator TEXT NOT NULL,              -- >, >=, <, <=, ==, !=, contains
  threshold TEXT NOT NULL,             -- 숫자/문자 모두 저장 가능
  severity TEXT NOT NULL DEFAULT 'warning', -- info/warning/critical
  window_seconds INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,  -- 0/1
  webhook_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_group_rules_group
  ON agent_group_rules(group_id, enabled, created_at DESC);

-- =========================
-- 8. 기존 테이블 연결 컬럼
-- =========================

ALTER TABLE agents ADD COLUMN group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL;
ALTER TABLE agent_registration_tokens ADD COLUMN group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL;

CREATE INDEX idx_agents_group_id ON agents(group_id);
CREATE INDEX idx_agent_reg_tokens_group_id ON agent_registration_tokens(group_id);
