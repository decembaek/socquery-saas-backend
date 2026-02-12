-- 그룹을 운영 단위로 구분하기 위한 카테고리
-- store / region / device_type / customer
ALTER TABLE agent_groups
ADD COLUMN category TEXT NOT NULL DEFAULT 'store';
