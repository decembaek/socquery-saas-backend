import { sign, verify } from 'hono/jwt';
import type { JwtPayload, UserRow } from '../types';

/**
 * Access Token 생성 (짧은 수명, 15분 기본)
 */
export async function createAccessToken(
  user: Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'account_id'>,
  secret: string,
  expiresInSeconds: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    account_id: user.account_id,
    iat: now,
    exp: now + expiresInSeconds,
  };

  return await sign(payload, secret, 'HS256');
}

/**
 * Refresh Token 생성 (긴 수명, 7일 기본)
 * - 랜덤 문자열로 생성, DB에 해시로 저장
 */
export function createRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Access Token 검증 및 페이로드 반환
 */
export async function verifyAccessToken(
  token: string,
  secret: string
): Promise<JwtPayload | null> {
  try {
    const payload = (await verify(token, secret, 'HS256')) as JwtPayload;
    return payload;
  } catch {
    return null;
  }
}
