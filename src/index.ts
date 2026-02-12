import { Hono } from 'hono';
import { AppEnv } from './types';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import auth from './routes/auth.js';
import agents from './routes/agents.js';
import iot from './routes/iot.js';

const app = new Hono<AppEnv>().basePath('/api/v1');

// ─── 공통 미들웨어 ───
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: '*', // 프로덕션에서는 특정 도메인으로 제한하세요
    allowHeaders: ['Content-Type', 'Authorization', 'X-IoT-Secret'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }),
);

// ─── 라우트 마운트 ───
app.route('/auth', auth);
app.route('/agents', agents);
app.route('/iot', iot);

// ─── 헬스 체크 ───
app.get('/health', (c) => c.json({ ok: true, timestamp: Date.now() }));

export default app;
