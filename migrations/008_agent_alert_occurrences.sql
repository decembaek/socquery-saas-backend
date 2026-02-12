-- 그룹 단위 알람 발생 이력
CREATE TABLE agent_alert_occurrences (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  metric TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  anomaly_type TEXT NOT NULL DEFAULT '',
  anomaly_data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (rule_id) REFERENCES agent_group_rules(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_alert_occurrences_group
  ON agent_alert_occurrences(group_id, created_at DESC);

CREATE INDEX idx_agent_alert_occurrences_agent
  ON agent_alert_occurrences(agent_id, created_at DESC);
