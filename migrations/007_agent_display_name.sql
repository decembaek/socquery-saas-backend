-- 에이전트 표시 이름(display_name) 도입
ALTER TABLE agents
ADD COLUMN display_name TEXT NOT NULL DEFAULT '';

ALTER TABLE agent_registration_tokens
ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
