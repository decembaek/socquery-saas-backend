-- webhook 알람 채널 확장 옵션
-- email 채널에서는 null 유지
ALTER TABLE agent_group_alert_channels
ADD COLUMN webhook_method TEXT;

ALTER TABLE agent_group_alert_channels
ADD COLUMN webhook_headers TEXT;

ALTER TABLE agent_group_alert_channels
ADD COLUMN webhook_body TEXT;
