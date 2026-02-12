import { Hono } from 'hono';
import { generateId } from '../utils/crypto';
import type {
  AppEnv,
  AgentRow,
  AgentGroupRuleRow,
  AgentGroupAlertChannelRow,
} from '../types';

const iot = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// IoT 웹훅 시크릿 검증 미들웨어
// ---------------------------------------------------------------------------

const iotSecretMiddleware = async (c: any, next: () => Promise<void>) => {
  const secret = c.req.header('X-IoT-Secret');
  if (!secret || secret !== c.env.IOT_WEBHOOK_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

// ---------------------------------------------------------------------------
// GET /iot/webhook - AWS IoT HTTPS Confirmation
// AWS IoT Core가 HTTPS Action 최초 설정 시 확인 요청
// ---------------------------------------------------------------------------

iot.get('/webhook', (c) => {
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /iot/webhook - IoT Core 이벤트 수신
// AWS IoT Core Rules Engine → HTTPS Action → 이 엔드포인트
// ---------------------------------------------------------------------------

iot.post('/webhook', iotSecretMiddleware, async (c) => {
  const body = await c.req.json<Record<string, any>>();
  const now = Math.floor(Date.now() / 1000);

  // IoT Core SQL에서 추출된 필드들
  const thingName = body.thingName as string;
  const tenantId = body.tenantId as string;
  const category = body.category as string; // agent, scan, system, anomaly
  const action = body.action as string; // status, response, usb, health, process, network, alert

  if (!thingName) {
    return c.json({ error: 'thingName 누락' }, 400);
  }

  // 에이전트 조회
  const agent = await c.env.DB.prepare(
    `SELECT * FROM agents WHERE thing_name = ?`,
  )
    .bind(thingName)
    .first<AgentRow>();

  if (!agent) {
    console.warn(`[IoT Webhook] 알 수 없는 에이전트: ${thingName}`);
    return c.json({ ok: true, warning: 'unknown agent' });
  }

  // 이벤트 타입 결정
  const eventType = resolveEventType(category, action);

  try {
    switch (eventType) {
      case 'status':
        await handleStatusEvent(c.env.DB, agent, body, now);
        break;
      case 'response':
        await handleResponseEvent(c.env.DB, agent, body, now);
        break;
      case 'telemetry':
      case 'scan':
        await handleTelemetryEvent(c.env.DB, agent, eventType, body, now);
        break;
      case 'anomaly':
        await handleTelemetryEvent(c.env.DB, agent, eventType, body, now);
        // 이상치 이벤트는 그룹 규칙을 매칭하고 알람 채널로 전달
        await matchRulesAndDispatchAlerts(
          c.env.DB,
          c.env,
          agent,
          body,
          now,
          tenantId,
        );
        break;
      default:
        // 알 수 없는 이벤트 → 일단 저장
        await handleTelemetryEvent(c.env.DB, agent, 'telemetry', body, now);
    }
  } catch (err: any) {
    console.error(
      `[IoT Webhook] 처리 에러 (${thingName}/${eventType}):`,
      err.message,
    );
    return c.json({ ok: false, error: err.message }, 500);
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 이벤트 타입 해석
// ---------------------------------------------------------------------------

function resolveEventType(category: string, action: string): string {
  // 새로운 토픽 구조: socquery/{tenant_id}/{thingName}/{category}/{action}
  if (category === 'agent') {
    if (action === 'status') return 'status';
    if (action === 'response') return 'response';
  }
  if (category === 'scan') return 'scan';
  if (category === 'system') return 'telemetry';
  if (category === 'anomaly') return 'anomaly';

  // 레거시 호환 (event 필드 기반)
  return action || 'telemetry';
}

// ---------------------------------------------------------------------------
// 이벤트 핸들러들
// ---------------------------------------------------------------------------

/**
 * 상태 변경 이벤트 (online/offline)
 * - agents.status 업데이트
 * - agents.last_seen_at 갱신
 * - 에이전트 메타 정보(os, arch, version) 업데이트
 * - agent_events에 기록
 */
async function handleStatusEvent(
  db: D1Database,
  agent: AgentRow,
  body: Record<string, any>,
  now: number,
) {
  const status = body.status === 'online' ? 'online' : 'offline';

  // 에이전트 상태 + 메타 정보 업데이트
  const sets = ['status = ?', 'last_seen_at = ?', 'updated_at = ?'];
  const params: any[] = [status, now, now];

  if (body.os) {
    sets.push('os = ?');
    params.push(body.os);
  }
  if (body.arch) {
    sets.push('arch = ?');
    params.push(body.arch);
  }
  if (body.version) {
    sets.push('version = ?');
    params.push(body.version);
  }

  params.push(agent.id);

  await db
    .prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  // 이벤트 기록
  await insertEvent(db, agent, 'status', body, now);
}

/**
 * 명령 응답 이벤트
 * - agent_commands 상태 업데이트 (completed / failed)
 * - agent_events에 기록
 * - agents.last_seen_at 갱신
 */
async function handleResponseEvent(
  db: D1Database,
  agent: AgentRow,
  body: Record<string, any>,
  now: number,
) {
  const commandId = body.commandId as string;

  if (commandId) {
    const exitCode = (body.exitCode as number) ?? -1;
    const cmdStatus = exitCode === 0 ? 'completed' : 'failed';

    await db
      .prepare(
        `UPDATE agent_commands
         SET status = ?, exit_code = ?, result = ?, error = ?, completed_at = ?
         WHERE id = ? AND agent_id = ?`,
      )
      .bind(
        cmdStatus,
        exitCode,
        body.data ? JSON.stringify(body.data) : null,
        body.error || null,
        now,
        commandId,
        agent.id,
      )
      .run();
  }

  // last_seen_at 갱신
  await db
    .prepare(`UPDATE agents SET last_seen_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, agent.id)
    .run();

  // 이벤트 기록
  await insertEvent(db, agent, 'response', body, now);
}

/**
 * 텔레메트리/스캔/이상치 이벤트
 * - agent_events에 기록
 * - agents.last_seen_at 갱신
 */
async function handleTelemetryEvent(
  db: D1Database,
  agent: AgentRow,
  type: string,
  body: Record<string, any>,
  now: number,
) {
  // last_seen_at 갱신
  await db
    .prepare(`UPDATE agents SET last_seen_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, agent.id)
    .run();

  // 이벤트 기록
  await insertEvent(db, agent, type, body, now);
}

// ---------------------------------------------------------------------------
// 공통 헬퍼
// ---------------------------------------------------------------------------

async function insertEvent(
  db: D1Database,
  agent: AgentRow,
  type: string,
  data: Record<string, any>,
  now: number,
) {
  const eventId = generateId();

  await db
    .prepare(
      `INSERT INTO agent_events (id, agent_id, account_id, type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(eventId, agent.id, agent.account_id, type, JSON.stringify(data), now)
    .run();
}

async function matchRulesAndDispatchAlerts(
  db: D1Database,
  bindings: AppEnv['Bindings'],
  agent: AgentRow,
  anomaly: Record<string, any>,
  now: number,
  tenantId: string,
) {
  if (!agent.group_id) return;

  const { results: rules } = await db
    .prepare(
      `SELECT * FROM agent_group_rules
       WHERE group_id = ? AND account_id = ? AND enabled = 1
       ORDER BY created_at DESC`,
    )
    .bind(agent.group_id, agent.account_id)
    .all<AgentGroupRuleRow>();

  if (!rules || rules.length === 0) return;

  const { results: channels } = await db
    .prepare(
      `SELECT * FROM agent_group_alert_channels
       WHERE group_id = ? AND account_id = ? AND enabled = 1
       ORDER BY created_at DESC`,
    )
    .bind(agent.group_id, agent.account_id)
    .all<AgentGroupAlertChannelRow>();

  if (!channels || channels.length === 0) return;

  // 쿨다운: 동일 rule + agent 조합으로 최근 N초 내 발송 이력이 있으면 스킵
  const COOLDOWN_SECONDS = 300; // 5분

  for (const rule of rules) {
    if (!isRuleMatched(rule, anomaly)) continue;

    // 쿨다운 체크: 최근 발송 이력 조회
    const cooldownCutoff = now - COOLDOWN_SECONDS;
    const recentOccurrence = await db
      .prepare(
        `SELECT id FROM agent_alert_occurrences
         WHERE rule_id = ? AND agent_id = ? AND created_at > ?
         LIMIT 1`,
      )
      .bind(rule.id, agent.id, cooldownCutoff)
      .first<{ id: string }>();

    if (recentOccurrence) {
      console.log(
        `[Alert] cooldown skip: rule=${rule.id}, agent=${agent.id} (last alert within ${COOLDOWN_SECONDS}s)`,
      );
      continue;
    }

    await saveAlertOccurrence(db, agent, anomaly, rule, now);
    await dispatchToChannels(
      bindings,
      channels,
      agent,
      anomaly,
      rule,
      now,
      tenantId,
    );
  }
}

async function saveAlertOccurrence(
  db: D1Database,
  agent: AgentRow,
  anomaly: Record<string, any>,
  rule: AgentGroupRuleRow,
  now: number,
) {
  if (!agent.group_id) return;
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO agent_alert_occurrences (
        id, account_id, group_id, agent_id, rule_id,
        severity, metric, message, anomaly_type, anomaly_data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      agent.account_id,
      agent.group_id,
      agent.id,
      rule.id,
      rule.severity,
      rule.metric,
      String(anomaly.message || ''),
      String(anomaly.type || ''),
      JSON.stringify(anomaly),
      now,
    )
    .run();
}

function isRuleMatched(
  rule: AgentGroupRuleRow,
  anomaly: Record<string, any>,
): boolean {
  const eventMetric = resolveEventMetric(anomaly);
  if ((rule.metric || '').toLowerCase() !== eventMetric) return false;

  const details = getDetails(anomaly);
  const durationSec = toNumber(details.durationSec);
  if (durationSec !== null && durationSec < rule.window_seconds) {
    return false;
  }

  const thresholdRaw = (rule.threshold || '').trim();
  const operator = (rule.operator || '==').trim();

  const numericCandidates = collectNumericCandidates(details);
  const stringCandidates = collectStringCandidates(anomaly, details);

  if (operator === 'contains') {
    const needle = thresholdRaw.toLowerCase();
    return stringCandidates.some((v) => v.includes(needle));
  }

  const thresholdNum = toNumber(thresholdRaw);
  if (
    thresholdNum !== null &&
    ['>', '>=', '<', '<=', '==', '!='].includes(operator) &&
    numericCandidates.length > 0
  ) {
    return numericCandidates.some((actual) =>
      compareNumeric(actual, operator, thresholdNum),
    );
  }

  if (operator === '==' || operator === '!=') {
    const eq = stringCandidates.some((v) => v === thresholdRaw.toLowerCase());
    return operator === '==' ? eq : !eq;
  }

  return false;
}

async function dispatchToChannels(
  bindings: AppEnv['Bindings'],
  channels: AgentGroupAlertChannelRow[],
  agent: AgentRow,
  anomaly: Record<string, any>,
  rule: AgentGroupRuleRow,
  now: number,
  tenantId: string,
) {
  for (const channel of channels) {
    try {
      if (channel.type === 'webhook') {
        await dispatchWebhook(channel, agent, anomaly, rule, now, tenantId);
      } else if (channel.type === 'email') {
        await dispatchEmail(
          bindings,
          channel,
          agent,
          anomaly,
          rule,
          now,
          tenantId,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(
        `[Alert] channel dispatch failed: channel=${channel.id}, rule=${rule.id}, error=${message}`,
      );
    }
  }
}

async function dispatchEmail(
  bindings: AppEnv['Bindings'],
  channel: AgentGroupAlertChannelRow,
  agent: AgentRow,
  anomaly: Record<string, any>,
  rule: AgentGroupRuleRow,
  now: number,
  tenantId: string,
) {
  if (!bindings.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not configured');
  }
  if (!bindings.RESEND_FROM_EMAIL) {
    throw new Error('RESEND_FROM_EMAIL not configured');
  }

  const severityLabel = rule.severity.toUpperCase();
  const agentName = agent.display_name || agent.thing_name;
  const subject = `[SocQuery][${severityLabel}] ${rule.name} - ${agentName}`;
  const ts = new Date(now * 1000).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const severityColors: Record<
    string,
    { bg: string; fg: string; border: string }
  > = {
    critical: { bg: '#fef2f2', fg: '#dc2626', border: '#fecaca' },
    warning: { bg: '#fffbeb', fg: '#d97706', border: '#fde68a' },
    info: { bg: '#eff6ff', fg: '#2563eb', border: '#bfdbfe' },
  };
  const sc = severityColors[rule.severity] || severityColors.info;

  const details = getDetails(anomaly);
  const anomalyMessage = String(
    anomaly.message || anomaly.type || 'Anomaly detected',
  );

  // 사람이 읽기 쉬운 상세 정보 행 생성
  const detailRows: string[] = [];
  const labelMap: Record<string, string> = {
    current: '현재 값',
    threshold: '임계치',
    metric: '메트릭',
    consecutiveCount: '연속 횟수',
    durationSec: '지속 시간(초)',
    cpuPercent: 'CPU 사용률(%)',
    memPercent: '메모리 사용률(%)',
    freeGB: '잔여 용량(GB)',
    totalGB: '전체 용량(GB)',
    failCount: '실패 횟수',
    disconnectCount: '끊김 횟수',
    closeWaitCount: 'CLOSE_WAIT 수',
    processName: '프로세스',
    deviceKey: '디바이스 키',
    vendor: '제조사',
    product: '제품명',
    serial: '시리얼',
    event: '이벤트',
    server: 'DNS 서버',
    latencyMs: '응답시간(ms)',
    windowMinutes: '관찰 윈도우(분)',
  };

  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined || value === '') continue;
    const label = labelMap[key] || key;
    const display =
      typeof value === 'number'
        ? Number.isInteger(value)
          ? String(value)
          : value.toFixed(1)
        : String(value);
    detailRows.push(
      `<tr><td style="padding:6px 12px;color:#6b7280;font-size:13px;border-bottom:1px solid #f3f4f6">${label}</td><td style="padding:6px 12px;color:#111827;font-size:13px;font-weight:500;border-bottom:1px solid #f3f4f6">${display}</td></tr>`,
    );
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden">
  <!-- Header -->
  <div style="background:${sc.bg};border-bottom:2px solid ${sc.border};padding:20px 24px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${sc.fg};margin-bottom:6px">${severityLabel} ALERT</div>
    <div style="font-size:18px;font-weight:600;color:#111827">${rule.name}</div>
    <div style="font-size:13px;color:#6b7280;margin-top:4px">${ts} (KST)</div>
  </div>

  <!-- Anomaly Message -->
  <div style="padding:20px 24px;border-bottom:1px solid #f3f4f6">
    <div style="font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:6px">감지된 이상</div>
    <div style="font-size:15px;color:#111827;line-height:1.5">${anomalyMessage}</div>
  </div>

  <!-- Agent Info -->
  <div style="padding:16px 24px;background:#f9fafb;border-bottom:1px solid #f3f4f6">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:4px 0;color:#6b7280;font-size:12px;width:100px">에이전트</td>
        <td style="padding:4px 0;color:#111827;font-size:13px;font-weight:500">${agentName}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280;font-size:12px">Thing Name</td>
        <td style="padding:4px 0;color:#111827;font-size:13px;font-family:monospace">${agent.thing_name}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280;font-size:12px">규칙 조건</td>
        <td style="padding:4px 0;color:#111827;font-size:13px">${rule.metric} ${rule.operator} ${rule.threshold} (${rule.window_seconds}초 이상)</td>
      </tr>
    </table>
  </div>

  <!-- Details Table -->
  ${
    detailRows.length > 0
      ? `
  <div style="padding:16px 24px">
    <div style="font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:8px">상세 데이터</div>
    <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:6px;overflow:hidden">
      ${detailRows.join('')}
    </table>
  </div>`
      : ''
  }

  <!-- Footer -->
  <div style="padding:16px 24px;border-top:1px solid #f3f4f6;text-align:center">
    <div style="font-size:11px;color:#9ca3af">SocQuery Monitoring &middot; Tenant ${tenantId}</div>
  </div>
</div>
</body></html>`;

  const payload = {
    from: bindings.RESEND_FROM_EMAIL,
    to: [channel.target],
    subject,
    html,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bindings.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`resend ${res.status}: ${text}`);
  }
}

async function dispatchWebhook(
  channel: AgentGroupAlertChannelRow,
  agent: AgentRow,
  anomaly: Record<string, any>,
  rule: AgentGroupRuleRow,
  now: number,
  tenantId: string,
) {
  const method = (channel.webhook_method || 'POST').toUpperCase();
  const context = buildTemplateContext(agent, anomaly, rule, now, tenantId);
  const headers = parseChannelHeaders(channel.webhook_headers, context);

  let bodyText = '';
  if (channel.webhook_body && channel.webhook_body.trim()) {
    bodyText = applyTemplate(channel.webhook_body, context);
  } else {
    bodyText = JSON.stringify({
      source: 'socquery',
      tenantId,
      timestamp: now,
      agent: {
        id: agent.id,
        thingName: agent.thing_name,
        displayName: agent.display_name || agent.name,
        groupId: agent.group_id,
      },
      rule: {
        id: rule.id,
        name: rule.name,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        severity: rule.severity,
      },
      anomaly,
    });
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(channel.target, {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyText,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`webhook ${res.status}: ${text}`);
  }
}

function parseChannelHeaders(
  raw: string | null,
  context: Record<string, string>,
): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = applyTemplate(v, context);
    }
    return result;
  } catch {
    return {};
  }
}

function buildTemplateContext(
  agent: AgentRow,
  anomaly: Record<string, any>,
  rule: AgentGroupRuleRow,
  now: number,
  tenantId: string,
): Record<string, string> {
  return {
    tenantId,
    timestamp: String(now),
    agentId: agent.id,
    thingName: agent.thing_name,
    displayName: agent.display_name || agent.name || '',
    groupId: agent.group_id || '',
    ruleId: rule.id,
    ruleName: rule.name,
    ruleMetric: rule.metric,
    ruleSeverity: rule.severity,
    anomalyType: String(anomaly.type || ''),
    anomalyCategory: String(anomaly.category || ''),
    anomalySeverity: String(anomaly.severity || ''),
    anomalyMessage: String(anomaly.message || ''),
  };
}

function applyTemplate(
  template: string,
  context: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => context[key] || '',
  );
}

function resolveEventMetric(anomaly: Record<string, any>): string {
  const details = getDetails(anomaly);
  if (typeof details.metric === 'string') return details.metric.toLowerCase();

  const category = String(anomaly.category || '').toLowerCase();
  if (category === 'process' || category === 'network' || category === 'usb') {
    return category;
  }

  const type = String(anomaly.type || '').toLowerCase();
  if (type.includes('cpu')) return 'cpu';
  if (type.includes('mem')) return 'memory';
  if (type.includes('disk')) return 'disk';
  if (
    type.includes('device_removed') ||
    type.includes('device_added') ||
    type.includes('critical_device')
  )
    return 'usb';
  return category || 'unknown';
}

function getDetails(anomaly: Record<string, any>): Record<string, any> {
  const raw = anomaly.details;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function collectNumericCandidates(details: Record<string, any>): number[] {
  const keys = [
    'current',
    'cpuPercent',
    'memPercent',
    'failCount',
    'disconnectCount',
    'closeWaitCount',
    'durationSec',
    'consecutiveCount',
  ];
  return keys
    .map((k) => toNumber(details[k]))
    .filter((v): v is number => v !== null);
}

function collectStringCandidates(
  anomaly: Record<string, any>,
  details: Record<string, any>,
): string[] {
  const values = [
    anomaly.type,
    anomaly.message,
    anomaly.category,
    anomaly.severity,
    details.event,
    details.processName,
    details.metric,
    details.deviceKey,
  ];
  return values
    .filter((v) => typeof v === 'string')
    .map((v) => String(v).toLowerCase());
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function compareNumeric(
  actual: number,
  operator: string,
  threshold: number,
): boolean {
  switch (operator) {
    case '>':
      return actual > threshold;
    case '>=':
      return actual >= threshold;
    case '<':
      return actual < threshold;
    case '<=':
      return actual <= threshold;
    case '==':
      return actual === threshold;
    case '!=':
      return actual !== threshold;
    default:
      return false;
  }
}

export default iot;
