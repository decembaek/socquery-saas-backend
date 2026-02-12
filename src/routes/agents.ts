import { Hono } from 'hono';
import { AwsClient } from 'aws4fetch';
import { authMiddleware } from '../middleware/auth';
import { generateId, sha256 } from '../utils/crypto';
import type {
  AppEnv,
  AgentRow,
  AgentEventRow,
  AgentCommandRow,
  AgentRegistrationTokenRow,
  AgentGroupRow,
  AgentGroupRuleRow,
  AgentGroupAlertChannelRow,
  AgentAlertOccurrenceRow,
} from '../types';

const agents = new Hono<AppEnv>();

const FREE_PLAN_AGENT_LIMIT = 3;

async function checkFreePlanAgentLimit(
  db: D1Database,
  accountId: string,
): Promise<{ allowed: boolean; count: number; message?: string }> {
  const account = await db
    .prepare('SELECT plan FROM accounts WHERE id = ?')
    .bind(accountId)
    .first<{ plan: string }>();
  if (!account || (account.plan || '').toLowerCase() !== 'free') {
    return { allowed: true, count: 0 };
  }
  const countResult = await db
    .prepare(
      'SELECT COUNT(*) as cnt FROM agents WHERE account_id = ?',
    )
    .bind(accountId)
    .first<{ cnt: number }>();
  const count = Number(countResult?.cnt ?? 0);
  if (count >= FREE_PLAN_AGENT_LIMIT) {
    return {
      allowed: false,
      count,
      message: `Free plan allows up to ${FREE_PLAN_AGENT_LIMIT} agents. (Current: ${count})`,
    };
  }
  return { allowed: true, count };
}

// ─── 인증: POST /register 제외 (에이전트는 등록 토큰만 보냄, JWT 없음)
agents.use('*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (c.req.method === 'POST' && pathname.endsWith('/agents/register'))
    return next();
  return authMiddleware(c, next);
});

// ---------------------------------------------------------------------------
// 등록 토큰 관리
// ---------------------------------------------------------------------------

/**
 * POST /agents/tokens - 장비 등록 토큰 발급
 * 웹 콘솔에서 새 장비를 등록하기 위한 일회성 토큰을 발급합니다.
 */
agents.post('/tokens', async (c) => {
  const jwt = c.get('jwtPayload');
  const body = await c.req.json<{
    display_name?: string;
    expires_in?: number;
    group_id?: string;
  }>();

  const displayName = body.display_name?.trim() || '';
  if (!displayName) {
    return c.json({ error: 'display_name은 필수입니다.' }, 400);
  }

  const limitCheck = await checkFreePlanAgentLimit(c.env.DB, jwt.account_id);
  if (!limitCheck.allowed && limitCheck.message) {
    return c.json({ error: limitCheck.message }, 403);
  }

  // 토큰 유효 시간 (기본 1시간, 최대 24시간)
  const expiresIn = Math.min(body.expires_in || 3600, 86400);
  const now = Math.floor(Date.now() / 1000);

  // 랜덤 토큰 생성 (48바이트 hex = 96자)
  const rawToken = Array.from(crypto.getRandomValues(new Uint8Array(48)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const tokenHash = await sha256(rawToken);
  const id = generateId();

  // group_id 검증 (선택)
  if (body.group_id) {
    const group = await c.env.DB.prepare(
      `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
    )
      .bind(body.group_id, jwt.account_id)
      .first<AgentGroupRow>();
    if (!group) {
      return c.json({ error: '유효하지 않은 그룹입니다.' }, 400);
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO agent_registration_tokens (id, account_id, group_id, token_hash, display_name, name, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      jwt.account_id,
      body.group_id || null,
      tokenHash,
      displayName,
      displayName,
      now + expiresIn,
      now,
    )
    .run();

  return c.json({
    token: rawToken,
    expires_at: now + expiresIn,
    expires_in: expiresIn,
    display_name: displayName,
    name: displayName,
    group_id: body.group_id || null,
  });
});

/**
 * GET /agents/tokens - 등록 토큰 목록 조회
 */
agents.get('/tokens', async (c) => {
  const jwt = c.get('jwtPayload');

  const { results } = await c.env.DB.prepare(
    `SELECT id, account_id, group_id, display_name, name, used_by_agent_id, expires_at, created_at
     FROM agent_registration_tokens
     WHERE account_id = ?
     ORDER BY created_at DESC
     LIMIT 50`,
  )
    .bind(jwt.account_id)
    .all<AgentRegistrationTokenRow>();

  const now = Math.floor(Date.now() / 1000);
  const tokens = (results || []).map((t) => ({
    id: t.id,
    display_name: t.display_name || t.name,
    name: t.display_name || t.name,
    group_id: t.group_id,
    used: !!t.used_by_agent_id,
    expired: t.expires_at < now,
    expires_at: t.expires_at,
    created_at: t.created_at,
  }));

  return c.json({ tokens });
});

// ---------------------------------------------------------------------------
// 그룹 관리
// ---------------------------------------------------------------------------

agents.get('/groups', async (c) => {
  const jwt = c.get('jwtPayload');
  const { results } = await c.env.DB.prepare(
    `SELECT g.*,
            (SELECT COUNT(*) FROM agents a WHERE a.group_id = g.id) AS agent_count
     FROM agent_groups g
     WHERE g.account_id = ?
     ORDER BY g.created_at DESC`,
  )
    .bind(jwt.account_id)
    .all<AgentGroupRow & { agent_count: number }>();
  return c.json({ groups: results || [] });
});

agents.get('/groups/:id', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const group = await c.env.DB.prepare(
    `SELECT g.*,
            (SELECT COUNT(*) FROM agents a WHERE a.group_id = g.id) AS agent_count
     FROM agent_groups g
     WHERE g.id = ? AND g.account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow & { agent_count: number }>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);
  return c.json({ group });
});

agents.post('/groups', async (c) => {
  const jwt = c.get('jwtPayload');
  const body = await c.req.json<{
    name: string;
    description?: string;
    category?: 'store' | 'region' | 'device_type' | 'customer';
  }>();
  if (!body.name?.trim()) {
    return c.json({ error: '그룹 이름이 필요합니다.' }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const id = generateId();
  await c.env.DB.prepare(
    `INSERT INTO agent_groups (id, account_id, name, category, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      jwt.account_id,
      body.name.trim(),
      body.category || 'store',
      body.description?.trim() || '',
      now,
      now,
    )
    .run();
  return c.json({ id, ok: true }, 201);
});

agents.put('/groups/:id', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    description?: string;
    category?: 'store' | 'region' | 'device_type' | 'customer';
  }>();
  const group = await c.env.DB.prepare(
    `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Math.floor(Date.now() / 1000)];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: '그룹 이름이 비어있습니다.' }, 400);
    sets.push('name = ?');
    params.push(body.name.trim());
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    params.push(body.description.trim());
  }
  if (body.category !== undefined) {
    sets.push('category = ?');
    params.push(body.category);
  }
  params.push(groupId);
  await c.env.DB
    .prepare(`UPDATE agent_groups SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();
  return c.json({ ok: true });
});

agents.get('/groups/:id/alerts-summary', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const group = await c.env.DB.prepare(
    `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);

  const now = Math.floor(Date.now() / 1000);
  const since24h = now - 24 * 60 * 60;
  const { results } = await c.env.DB.prepare(
    `SELECT e.data, e.created_at
       FROM agent_events e
      WHERE e.type = 'anomaly'
        AND e.created_at >= ?
        AND e.agent_id IN (
          SELECT a.id FROM agents a WHERE a.group_id = ? AND a.account_id = ?
        )
      ORDER BY e.created_at DESC
      LIMIT 500`,
  )
    .bind(since24h, groupId, jwt.account_id)
    .all<{ data: string; created_at: number }>();

  let critical = 0;
  let warning = 0;
  let info = 0;
  let total = 0;
  let last_alert_at: number | null = null;

  for (const row of results || []) {
    total += 1;
    if (!last_alert_at) last_alert_at = row.created_at;
    try {
      const parsed = JSON.parse(row.data || '{}') as { severity?: string };
      const s = (parsed.severity || 'warning').toLowerCase();
      if (s === 'critical') critical += 1;
      else if (s === 'info') info += 1;
      else warning += 1;
    } catch {
      warning += 1;
    }
  }

  return c.json({
    summary: {
      total,
      critical,
      warning,
      info,
      last_alert_at,
      window_hours: 24,
    },
  });
});

agents.delete('/groups/:id', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const group = await c.env.DB.prepare(
    `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);

  // FK ON DELETE SET NULL로 에이전트/토큰 group_id는 null 처리됨
  await c.env.DB.prepare(`DELETE FROM agent_groups WHERE id = ?`).bind(groupId).run();
  return c.json({ ok: true });
});

agents.get('/groups/:id/rules', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const group = await c.env.DB.prepare(
    `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM agent_group_rules WHERE group_id = ? ORDER BY created_at DESC`,
  )
    .bind(groupId)
    .all<AgentGroupRuleRow>();
  return c.json({ rules: results || [] });
});

agents.post('/groups/:id/rules', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const body = await c.req.json<{
    name: string;
    metric: string;
    operator: string;
    threshold: string;
    severity?: 'info' | 'warning' | 'critical';
    window_seconds?: number;
    enabled?: boolean;
    webhook_url?: string;
  }>();
  const group = await c.env.DB.prepare(
    `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);
  if (!body.name?.trim() || !body.metric?.trim() || !body.operator?.trim()) {
    return c.json({ error: '필수값(name/metric/operator)이 누락되었습니다.' }, 400);
  }
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO agent_group_rules (
      id, group_id, account_id, name, metric, operator, threshold,
      severity, window_seconds, enabled, webhook_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      groupId,
      jwt.account_id,
      body.name.trim(),
      body.metric.trim(),
      body.operator.trim(),
      body.threshold ?? '',
      body.severity || 'warning',
      body.window_seconds || 60,
      body.enabled === false ? 0 : 1,
      body.webhook_url || null,
      now,
      now,
    )
    .run();
  return c.json({ id, ok: true }, 201);
});

agents.put('/groups/:groupId/rules/:ruleId', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('groupId');
  const ruleId = c.req.param('ruleId');
  const body = await c.req.json<{
    name?: string;
    metric?: string;
    operator?: string;
    threshold?: string;
    severity?: 'info' | 'warning' | 'critical';
    window_seconds?: number;
    enabled?: boolean;
    webhook_url?: string;
  }>();
  const row = await c.env.DB.prepare(
    `SELECT id FROM agent_group_rules WHERE id = ? AND group_id = ? AND account_id = ?`,
  )
    .bind(ruleId, groupId, jwt.account_id)
    .first<AgentGroupRuleRow>();
  if (!row) return c.json({ error: '규칙을 찾을 수 없습니다.' }, 404);

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Math.floor(Date.now() / 1000)];
  if (body.name !== undefined) {
    sets.push('name = ?');
    params.push(body.name.trim());
  }
  if (body.metric !== undefined) {
    sets.push('metric = ?');
    params.push(body.metric.trim());
  }
  if (body.operator !== undefined) {
    sets.push('operator = ?');
    params.push(body.operator.trim());
  }
  if (body.threshold !== undefined) {
    sets.push('threshold = ?');
    params.push(body.threshold);
  }
  if (body.severity !== undefined) {
    sets.push('severity = ?');
    params.push(body.severity);
  }
  if (body.window_seconds !== undefined) {
    sets.push('window_seconds = ?');
    params.push(body.window_seconds);
  }
  if (body.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(body.enabled ? 1 : 0);
  }
  if (body.webhook_url !== undefined) {
    sets.push('webhook_url = ?');
    params.push(body.webhook_url || null);
  }
  params.push(ruleId);
  await c.env.DB
    .prepare(`UPDATE agent_group_rules SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();
  return c.json({ ok: true });
});

agents.delete('/groups/:groupId/rules/:ruleId', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('groupId');
  const ruleId = c.req.param('ruleId');
  await c.env.DB.prepare(
    `DELETE FROM agent_group_rules WHERE id = ? AND group_id = ? AND account_id = ?`,
  )
    .bind(ruleId, groupId, jwt.account_id)
    .run();
  return c.json({ ok: true });
});

agents.get('/groups/:id/alert-channels', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const group = await c.env.DB.prepare(
    `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM agent_group_alert_channels
     WHERE group_id = ?
     ORDER BY created_at DESC`,
  )
    .bind(groupId)
    .all<AgentGroupAlertChannelRow>();

  return c.json({ channels: results || [] });
});

agents.post('/groups/:id/alert-channels', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const body = await c.req.json<{
    type: 'email' | 'webhook';
    target: string;
    enabled?: boolean;
    webhook_method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    webhook_headers?: Record<string, string>;
    webhook_body?: string;
  }>();

  const group = await c.env.DB.prepare(
    `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);

  if (body.type !== 'email' && body.type !== 'webhook') {
    return c.json({ error: '지원하지 않는 채널 타입입니다.' }, 400);
  }
  if (!body.target?.trim()) {
    return c.json({ error: '채널 대상값(target)이 필요합니다.' }, 400);
  }

  const target = body.target.trim();
  if (body.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
    return c.json({ error: '유효한 이메일 형식이 아닙니다.' }, 400);
  }
  if (body.type === 'webhook' && !/^https?:\/\/.+/i.test(target)) {
    return c.json({ error: '유효한 webhook URL 형식이 아닙니다.' }, 400);
  }

  let webhookMethod: string | null = null;
  let webhookHeaders: string | null = null;
  let webhookBody: string | null = null;

  if (body.type === 'webhook') {
    webhookMethod = body.webhook_method || 'POST';
    const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (!allowed.includes(webhookMethod)) {
      return c.json({ error: '지원하지 않는 webhook method입니다.' }, 400);
    }
    if (body.webhook_headers !== undefined) {
      webhookHeaders = JSON.stringify(body.webhook_headers || {});
    }
    if (body.webhook_body !== undefined) {
      webhookBody = body.webhook_body || '';
    }
  }

  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO agent_group_alert_channels (
      id, group_id, account_id, type, target, webhook_method, webhook_headers, webhook_body, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      groupId,
      jwt.account_id,
      body.type,
      target,
      webhookMethod,
      webhookHeaders,
      webhookBody,
      body.enabled === false ? 0 : 1,
      now,
      now,
    )
    .run();

  return c.json({ id, ok: true }, 201);
});

agents.put('/groups/:groupId/alert-channels/:channelId', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('groupId');
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{
    target?: string;
    enabled?: boolean;
    webhook_method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    webhook_headers?: Record<string, string>;
    webhook_body?: string;
  }>();

  const row = await c.env.DB.prepare(
    `SELECT * FROM agent_group_alert_channels
     WHERE id = ? AND group_id = ? AND account_id = ?`,
  )
    .bind(channelId, groupId, jwt.account_id)
    .first<AgentGroupAlertChannelRow>();
  if (!row) return c.json({ error: '채널을 찾을 수 없습니다.' }, 404);

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Math.floor(Date.now() / 1000)];

  if (body.target !== undefined) {
    const target = body.target.trim();
    if (!target) return c.json({ error: '채널 대상값(target)이 비어있습니다.' }, 400);
    if (row.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      return c.json({ error: '유효한 이메일 형식이 아닙니다.' }, 400);
    }
    if (row.type === 'webhook' && !/^https?:\/\/.+/i.test(target)) {
      return c.json({ error: '유효한 webhook URL 형식이 아닙니다.' }, 400);
    }
    sets.push('target = ?');
    params.push(target);
  }

  if (body.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(body.enabled ? 1 : 0);
  }

  if (row.type === 'webhook' && body.webhook_method !== undefined) {
    const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (!allowed.includes(body.webhook_method)) {
      return c.json({ error: '지원하지 않는 webhook method입니다.' }, 400);
    }
    sets.push('webhook_method = ?');
    params.push(body.webhook_method);
  }

  if (row.type === 'webhook' && body.webhook_headers !== undefined) {
    sets.push('webhook_headers = ?');
    params.push(JSON.stringify(body.webhook_headers || {}));
  }

  if (row.type === 'webhook' && body.webhook_body !== undefined) {
    sets.push('webhook_body = ?');
    params.push(body.webhook_body || '');
  }

  params.push(channelId);
  await c.env.DB
    .prepare(`UPDATE agent_group_alert_channels SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  return c.json({ ok: true });
});

agents.delete('/groups/:groupId/alert-channels/:channelId', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('groupId');
  const channelId = c.req.param('channelId');

  await c.env.DB.prepare(
    `DELETE FROM agent_group_alert_channels
     WHERE id = ? AND group_id = ? AND account_id = ?`,
  )
    .bind(channelId, groupId, jwt.account_id)
    .run();

  return c.json({ ok: true });
});

agents.get('/groups/:id/alerts', async (c) => {
  const jwt = c.get('jwtPayload');
  const groupId = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const group = await c.env.DB.prepare(
    `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<AgentGroupRow>();
  if (!group) return c.json({ error: '그룹을 찾을 수 없습니다.' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT ao.*,
            a.display_name AS agent_display_name,
            a.thing_name AS agent_thing_name,
            r.name AS rule_name
       FROM agent_alert_occurrences ao
       LEFT JOIN agents a ON a.id = ao.agent_id
       LEFT JOIN agent_group_rules r ON r.id = ao.rule_id
      WHERE ao.group_id = ? AND ao.account_id = ?
      ORDER BY ao.created_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(groupId, jwt.account_id, limit, offset)
    .all<
      AgentAlertOccurrenceRow & {
        agent_display_name: string | null;
        agent_thing_name: string | null;
        rule_name: string | null;
      }
    >();

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as total
       FROM agent_alert_occurrences
      WHERE group_id = ? AND account_id = ?`,
  )
    .bind(groupId, jwt.account_id)
    .first<{ total: number }>();

  const alerts = (results || []).map((row) => ({
    ...row,
    anomaly_data: JSON.parse(row.anomaly_data || '{}'),
  }));

  return c.json({
    alerts,
    total: countRow?.total || 0,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// 에이전트 등록 (토큰 기반)
// ---------------------------------------------------------------------------

/**
 * POST /agents/register - 에이전트 장비 등록
 * 에이전트 클라이언트가 등록 토큰 + machineId로 호출합니다.
 *
 * 이 엔드포인트는 authMiddleware로 보호되지만,
 * 실제로는 등록 토큰 검증이 핵심입니다.
 * (추후 별도 토큰 인증으로 분리 가능)
 */
agents.post('/register', async (c) => {
  const body = await c.req.json<{ token: string; machineId: string }>();

  if (!body.token || !body.machineId) {
    return c.json({ error: 'token과 machineId가 필요합니다.' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  // 1. 등록 토큰 검증 (JWT 없이 토큰만으로 조회)
  const tokenHash = await sha256(body.token);
  const tokenRow = await c.env.DB.prepare(
    `SELECT * FROM agent_registration_tokens WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<AgentRegistrationTokenRow>();

  if (!tokenRow) {
    return c.json({ error: '유효하지 않은 등록 토큰입니다.' }, 401);
  }

  if (tokenRow.used_by_agent_id) {
    return c.json({ error: '이미 사용된 등록 토큰입니다.' }, 409);
  }

  if (tokenRow.expires_at < now) {
    return c.json({ error: '만료된 등록 토큰입니다.' }, 410);
  }

  const limitCheck = await checkFreePlanAgentLimit(c.env.DB, tokenRow.account_id);
  if (!limitCheck.allowed && limitCheck.message) {
    return c.json({ error: limitCheck.message }, 403);
  }

  // 2. AWS IoT Core 프로비저닝
  const aws = new AwsClient({
    accessKeyId: c.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    region: c.env.AWS_REGION,
  });

  const iotEndpoint = `https://iot.${c.env.AWS_REGION}.amazonaws.com`;
  const thingName = `socquery-agent-${generateId()}`;

  try {
    // 인증서 + 키 쌍 생성
    const certRes = await aws.fetch(
      `${iotEndpoint}/keys-and-certificate?setAsActive=true`,
      { method: 'POST' },
    );
    if (!certRes.ok) {
      const errBody = await certRes.text();
      throw new Error(`인증서 생성 실패 (${certRes.status}): ${errBody}`);
    }
    const certData: any = await certRes.json();

    // Thing(사물) 생성
    const thingRes = await aws.fetch(`${iotEndpoint}/things/${thingName}`, {
      method: 'POST',
      body: JSON.stringify({ thingName }),
    });
    if (!thingRes.ok) {
      const errBody = await thingRes.text();
      throw new Error(`Thing 생성 실패 (${thingRes.status}): ${errBody}`);
    }

    // Thing ↔ 인증서 연결
    const attachRes = await aws.fetch(
      `${iotEndpoint}/things/${thingName}/principals`,
      {
        method: 'PUT',
        headers: { 'x-amzn-principal': certData.certificateArn },
      },
    );
    if (!attachRes.ok) {
      const errBody = await attachRes.text();
      throw new Error(
        `Thing-인증서 연결 실패 (${attachRes.status}): ${errBody}`,
      );
    }

    // 정책 할당
    const policyName = 'Socquery_SaaS_Agent_policy';
    const policyRes = await aws.fetch(
      `${iotEndpoint}/target-policies/${policyName}`,
      {
        method: 'PUT',
        body: JSON.stringify({ target: certData.certificateArn }),
      },
    );
    if (!policyRes.ok) {
      const errBody = await policyRes.text();
      throw new Error(`정책 할당 실패 (${policyRes.status}): ${errBody}`);
    }

    // 3. DB에 에이전트 저장
    const agentId = generateId();
    await c.env.DB.prepare(
      `INSERT INTO agents (id, account_id, group_id, thing_name, machine_id, certificate_arn, display_name, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?)`,
    )
      .bind(
        agentId,
        tokenRow.account_id,
        tokenRow.group_id || null,
        thingName,
        body.machineId,
        certData.certificateArn,
        tokenRow.display_name || tokenRow.name || '',
        tokenRow.display_name || tokenRow.name || '',
        now,
        now,
      )
      .run();

    // 4. 등록 토큰 사용 처리
    await c.env.DB.prepare(
      `UPDATE agent_registration_tokens SET used_by_agent_id = ? WHERE id = ?`,
    )
      .bind(agentId, tokenRow.id)
      .run();

    // 5. 연결 정보 반환
    return c.json({
      success: true,
      thingName,
      tenant_id: tokenRow.account_id,
      certificatePem: certData.certificatePem,
      privateKey: certData.keyPair.PrivateKey,
      iotEndpoint: c.env.IOT_ATS_ENDPOINT,
      region: c.env.AWS_REGION,
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// ---------------------------------------------------------------------------
// 에이전트 CRUD
// ---------------------------------------------------------------------------

/**
 * GET /agents - 장비 목록 조회
 */
agents.get('/', async (c) => {
  const jwt = c.get('jwtPayload');
  const status = c.req.query('status'); // optional filter
  const groupId = c.req.query('group_id'); // optional filter
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  let query = `SELECT * FROM agents WHERE account_id = ?`;
  const params: any[] = [jwt.account_id];

  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }
  if (groupId) {
    query += ` AND group_id = ?`;
    params.push(groupId);
  }

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(query)
    .bind(...params)
    .all<AgentRow>();

  // 전체 카운트
  let countQuery = `SELECT COUNT(*) as total FROM agents WHERE account_id = ?`;
  const countParams: unknown[] = [jwt.account_id];
  if (status) {
    countQuery += ` AND status = ?`;
    countParams.push(status);
  }
  if (groupId) {
    countQuery += ` AND group_id = ?`;
    countParams.push(groupId);
  }
  const countResult = await c.env.DB.prepare(countQuery)
    .bind(...countParams)
    .first<{ total: number }>();

  return c.json({
    agents: results || [],
    total: countResult?.total || 0,
    limit,
    offset,
  });
});

/**
 * GET /agents/:id - 장비 상세 조회
 */
agents.get('/:id', async (c) => {
  const jwt = c.get('jwtPayload');
  const agentId = c.req.param('id');

  const agent = await c.env.DB.prepare(
    `SELECT * FROM agents WHERE id = ? AND account_id = ?`,
  )
    .bind(agentId, jwt.account_id)
    .first<AgentRow>();

  if (!agent) {
    return c.json({ error: '장비를 찾을 수 없습니다.' }, 404);
  }

  return c.json({ agent });
});

/**
 * PUT /agents/:id - 장비 정보 수정 (이름, 설명)
 */
agents.put('/:id', async (c) => {
  const jwt = c.get('jwtPayload');
  const agentId = c.req.param('id');
  const body = await c.req.json<{
    display_name?: string;
    name?: string;
    description?: string;
    group_id?: string | null;
  }>();

  const agent = await c.env.DB.prepare(
    `SELECT id FROM agents WHERE id = ? AND account_id = ?`,
  )
    .bind(agentId, jwt.account_id)
    .first<AgentRow>();

  if (!agent) {
    return c.json({ error: '장비를 찾을 수 없습니다.' }, 404);
  }

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ['updated_at = ?'];
  const params: any[] = [now];

  if (body.display_name !== undefined) {
    sets.push('display_name = ?');
    params.push(body.display_name);
    // 하위 호환: 기존 name 사용 화면도 동일 값 유지
    sets.push('name = ?');
    params.push(body.display_name);
  }
  if (body.name !== undefined) {
    sets.push('name = ?');
    params.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    params.push(body.description);
  }
  if (body.group_id !== undefined) {
    if (body.group_id) {
      const group = await c.env.DB.prepare(
        `SELECT id FROM agent_groups WHERE id = ? AND account_id = ?`,
      )
        .bind(body.group_id, jwt.account_id)
        .first<AgentGroupRow>();
      if (!group) return c.json({ error: '유효하지 않은 그룹입니다.' }, 400);
      sets.push('group_id = ?');
      params.push(body.group_id);
    } else {
      sets.push('group_id = ?');
      params.push(null);
    }
  }

  params.push(agentId);

  await c.env.DB.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  return c.json({ ok: true });
});

/**
 * DELETE /agents/:id - 장비 삭제 (인증서 폐기 포함)
 */
agents.delete('/:id', async (c) => {
  const jwt = c.get('jwtPayload');
  const agentId = c.req.param('id');

  const agent = await c.env.DB.prepare(
    `SELECT * FROM agents WHERE id = ? AND account_id = ?`,
  )
    .bind(agentId, jwt.account_id)
    .first<AgentRow>();

  if (!agent) {
    return c.json({ error: '장비를 찾을 수 없습니다.' }, 404);
  }

  // AWS IoT Core 인증서 비활성화 + Thing 분리 (best effort)
  if (agent.certificate_arn) {
    try {
      const aws = new AwsClient({
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        region: c.env.AWS_REGION,
      });
      const iotEndpoint = `https://iot.${c.env.AWS_REGION}.amazonaws.com`;

      // Thing ↔ 인증서 분리
      await aws.fetch(`${iotEndpoint}/things/${agent.thing_name}/principals`, {
        method: 'DELETE',
        headers: { 'x-amzn-principal': agent.certificate_arn },
      });

      // 인증서 비활성화
      const certId = agent.certificate_arn.split('/').pop();
      await aws.fetch(
        `${iotEndpoint}/certificates/${certId}?newStatus=INACTIVE`,
        { method: 'PUT' },
      );

      // Thing 삭제
      await aws.fetch(`${iotEndpoint}/things/${agent.thing_name}`, {
        method: 'DELETE',
      });
    } catch (err: any) {
      console.error(
        `[Agents] AWS IoT 정리 실패 (${agent.thing_name}):`,
        err.message,
      );
      // 실패해도 DB는 삭제 진행
    }
  }

  // DB 삭제 (CASCADE로 events, commands도 삭제)
  await c.env.DB.prepare(`DELETE FROM agents WHERE id = ?`).bind(agentId).run();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 에이전트 이벤트 이력
// ---------------------------------------------------------------------------

/**
 * GET /agents/:id/events - 장비 이벤트 이력 조회
 */
agents.get('/:id/events', async (c) => {
  const jwt = c.get('jwtPayload');
  const agentId = c.req.param('id');
  const type = c.req.query('type'); // optional filter
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  // 장비 소유권 확인
  const agent = await c.env.DB.prepare(
    `SELECT id FROM agents WHERE id = ? AND account_id = ?`,
  )
    .bind(agentId, jwt.account_id)
    .first<AgentRow>();

  if (!agent) {
    return c.json({ error: '장비를 찾을 수 없습니다.' }, 404);
  }

  let query = `SELECT * FROM agent_events WHERE agent_id = ?`;
  const params: any[] = [agentId];

  if (type) {
    query += ` AND type = ?`;
    params.push(type);
  }

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(query)
    .bind(...params)
    .all<AgentEventRow>();

  // JSON data 파싱
  const events = (results || []).map((e) => ({
    ...e,
    data: JSON.parse(e.data || '{}'),
  }));

  return c.json({ events, limit, offset });
});

// ---------------------------------------------------------------------------
// 명령 전달
// ---------------------------------------------------------------------------

/**
 * POST /agents/:id/commands - 에이전트에 명령 전달
 * 서버 → MQTT → 에이전트
 */
agents.post('/:id/commands', async (c) => {
  const jwt = c.get('jwtPayload');
  const agentId = c.req.param('id');
  const body = await c.req.json<{
    action: string;
    params?: Record<string, any>;
    timeout?: number;
  }>();

  if (!body.action) {
    return c.json({ error: 'action이 필요합니다.' }, 400);
  }

  // 장비 조회
  const agent = await c.env.DB.prepare(
    `SELECT * FROM agents WHERE id = ? AND account_id = ?`,
  )
    .bind(agentId, jwt.account_id)
    .first<AgentRow>();

  if (!agent) {
    return c.json({ error: '장비를 찾을 수 없습니다.' }, 404);
  }

  if (agent.status === 'revoked') {
    return c.json({ error: '폐기된 장비에는 명령을 전달할 수 없습니다.' }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const commandId = generateId();
  const timeout = body.timeout || 30;

  // 1. DB에 명령 기록
  await c.env.DB.prepare(
    `INSERT INTO agent_commands (id, agent_id, account_id, action, params, status, created_at, timeout_seconds)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      commandId,
      agentId,
      jwt.account_id,
      body.action,
      JSON.stringify(body.params || {}),
      now,
      timeout,
    )
    .run();

  // 2. MQTT로 명령 발행 (AWS IoT Core Data Plane)
  const mqttPayload = {
    commandId,
    action: body.action,
    params: body.params || {},
    timeout,
  };

  const topic = `socquery/${jwt.account_id}/${agent.thing_name}/agent/command`;

  try {
    const aws = new AwsClient({
      accessKeyId: c.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      region: c.env.AWS_REGION,
      service: 'iotdata',
    });

    // AWS IoT Core HTTPS Publish API
    // 토픽의 '/'를 URL path '/'로 직접 사용 (SigV4에서 정규 경로 계산 시 일관성 유지)
    const publishUrl = `https://${c.env.IOT_ATS_ENDPOINT}/topics/${topic}?qos=1`;
    const bodyStr = JSON.stringify(mqttPayload);

    console.log(`[Agents] MQTT Publish: topic=${topic}`);

    // sign → 서명된 헤더를 추출하여 직접 fetch
    const signed = await aws.sign(publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    });

    // signed는 Request 객체 → 직접 fetch에 전달
    const mqttRes = await fetch(signed);

    if (!mqttRes.ok) {
      const errText = await mqttRes.text();
      console.error(
        `[Agents] MQTT 발행 실패: status=${mqttRes.status}, body=${errText}, url=${publishUrl}`,
      );

      // DB 상태 업데이트: failed
      await c.env.DB.prepare(
        `UPDATE agent_commands SET status = 'failed', error = ? WHERE id = ?`,
      )
        .bind(`MQTT 발행 실패: ${mqttRes.status}`, commandId)
        .run();

      return c.json({ error: 'MQTT 명령 전달 실패', detail: errText }, 502);
    }

    // 발행 성공 → delivered
    await c.env.DB.prepare(
      `UPDATE agent_commands SET status = 'delivered' WHERE id = ?`,
    )
      .bind(commandId)
      .run();
  } catch (err: any) {
    console.error(`[Agents] MQTT 발행 에러:`, err.message);

    await c.env.DB.prepare(
      `UPDATE agent_commands SET status = 'failed', error = ? WHERE id = ?`,
    )
      .bind(err.message, commandId)
      .run();

    return c.json(
      { error: 'MQTT 발행 중 에러 발생', detail: err.message },
      500,
    );
  }

  return c.json({
    commandId,
    action: body.action,
    status: 'delivered',
    agent: {
      id: agent.id,
      thing_name: agent.thing_name,
      status: agent.status,
    },
  });
});

/**
 * GET /agents/:id/commands - 명령 이력 조회
 */
agents.get('/:id/commands', async (c) => {
  const jwt = c.get('jwtPayload');
  const agentId = c.req.param('id');
  const status = c.req.query('status');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  // 장비 소유권 확인
  const agent = await c.env.DB.prepare(
    `SELECT id FROM agents WHERE id = ? AND account_id = ?`,
  )
    .bind(agentId, jwt.account_id)
    .first<AgentRow>();

  if (!agent) {
    return c.json({ error: '장비를 찾을 수 없습니다.' }, 404);
  }

  let query = `SELECT * FROM agent_commands WHERE agent_id = ?`;
  const params: any[] = [agentId];

  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(query)
    .bind(...params)
    .all<AgentCommandRow>();

  // JSON 파싱
  const commands = (results || []).map((cmd) => ({
    ...cmd,
    params: JSON.parse(cmd.params || '{}'),
    result: cmd.result ? JSON.parse(cmd.result) : null,
  }));

  return c.json({ commands, limit, offset });
});

export default agents;
