-- 그룹 단위 알람 채널 설정
-- type: email | webhook
CREATE TABLE agent_group_alert_channels (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_group_alert_channels_group
  ON agent_group_alert_channels(group_id, enabled, created_at DESC);
