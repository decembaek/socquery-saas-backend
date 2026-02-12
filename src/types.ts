import type { Context } from 'hono';

// ─── Cloudflare Bindings ───

export type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  JWT_ACCESS_EXPIRES_IN: string; // seconds (default: 900 = 15분)
  JWT_REFRESH_EXPIRES_IN: string; // seconds (default: 604800 = 7일)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  IOT_ATS_ENDPOINT: string;
  IOT_WEBHOOK_SECRET: string; // IoT 웹훅 시크릿 (X-IoT-Secret)
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
};

// ─── JWT Payload ───

export type JwtPayload = {
  sub: string; // user id
  email: string;
  name: string;
  role: string;
  account_id: string;
  iat: number;
  exp: number;
};

// ─── Hono Variables (미들웨어에서 주입) ───

export type Variables = {
  jwtPayload: JwtPayload;
  userId: string;
};

// ─── App Type ───

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type AppContext = Context<AppEnv>;

// ─── DB Row Types ───

export type AccountRow = {
  id: string;
  name: string;
  plan: string;
  status: string;
  created_at: number;
  updated_at: number;
};

export type UserRow = {
  id: string;
  account_id: string;
  email: string;
  password_hash: string | null;
  name: string;
  role: string;
  status: string;
  created_at: number;
  updated_at: number;
};

export type RefreshTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  device_info: string | null;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
};

// ─── Agent DB Row Types ───

export type AgentRow = {
  id: string;
  account_id: string;
  group_id: string | null;
  thing_name: string;
  machine_id: string | null;
  certificate_arn: string | null;
  display_name: string;
  name: string;
  description: string;
  status: 'online' | 'offline' | 'revoked';
  os: string;
  arch: string;
  version: string;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
};

export type AgentEventRow = {
  id: string;
  agent_id: string;
  account_id: string;
  type: 'status' | 'telemetry' | 'scan' | 'anomaly' | 'response';
  data: string; // JSON string
  created_at: number;
};

export type AgentCommandRow = {
  id: string;
  agent_id: string;
  account_id: string;
  action: string;
  params: string; // JSON string
  status: 'pending' | 'delivered' | 'completed' | 'failed' | 'timeout';
  exit_code: number | null;
  result: string | null; // JSON string
  error: string | null;
  created_at: number;
  completed_at: number | null;
  timeout_seconds: number;
};

export type AgentRegistrationTokenRow = {
  id: string;
  account_id: string;
  group_id: string | null;
  token_hash: string;
  display_name: string;
  name: string;
  used_by_agent_id: string | null;
  expires_at: number;
  created_at: number;
};

export type AgentGroupRow = {
  id: string;
  account_id: string;
  name: string;
  category: 'store' | 'region' | 'device_type' | 'customer';
  description: string;
  created_at: number;
  updated_at: number;
};

export type AgentGroupRuleRow = {
  id: string;
  group_id: string;
  account_id: string;
  name: string;
  metric: string;
  operator: string;
  threshold: string;
  severity: 'info' | 'warning' | 'critical';
  window_seconds: number;
  enabled: number;
  webhook_url: string | null;
  created_at: number;
  updated_at: number;
};

export type AgentGroupAlertChannelRow = {
  id: string;
  group_id: string;
  account_id: string;
  type: 'email' | 'webhook';
  target: string;
  webhook_method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | null;
  webhook_headers: string | null; // JSON string
  webhook_body: string | null; // raw string (typically JSON)
  enabled: number;
  created_at: number;
  updated_at: number;
};

export type AgentAlertOccurrenceRow = {
  id: string;
  account_id: string;
  group_id: string;
  agent_id: string;
  rule_id: string;
  severity: 'info' | 'warning' | 'critical';
  metric: string;
  message: string;
  anomaly_type: string;
  anomaly_data: string;
  created_at: number;
};
