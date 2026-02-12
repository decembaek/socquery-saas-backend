import { createMiddleware } from 'hono/factory';
import { verifyAccessToken } from '../utils/jwt';
import type { AppEnv } from '../types';

/**
 * JWT 인증 미들웨어
 * - Authorization: Bearer <token> 헤더에서 토큰 추출
 * - 검증 후 c.set('jwtPayload', payload) 및 c.set('userId', sub) 세팅
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization 헤더가 필요합니다.' }, 401);
  }

  const token = authHeader.slice(7);
  const secret = c.env.JWT_SECRET;

  const payload = await verifyAccessToken(token, secret);

  if (!payload) {
    return c.json({ error: '유효하지 않거나 만료된 토큰입니다.' }, 401);
  }

  c.set('jwtPayload', payload);
  c.set('userId', payload.sub);

  await next();
});
