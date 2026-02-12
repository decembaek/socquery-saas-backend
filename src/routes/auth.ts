import { Hono } from 'hono';
import {
  hashPassword,
  verifyPassword,
  generateId,
  sha256,
} from '../utils/crypto';
import { createAccessToken, createRefreshToken } from '../utils/jwt';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv, UserRow, RefreshTokenRow } from '../types';

const auth = new Hono<AppEnv>();

// ─────────────────────────────────────────
// POST /auth/register - 회원가입
// ─────────────────────────────────────────
auth.post('/register', async (c) => {
  const body = await c.req.json<{
    email: string;
    password: string;
    name: string;
    account_name?: string;
    device_info?: string;
  }>();

  // 유효성 검사
  if (!body.email || !body.password || !body.name) {
    return c.json({ error: 'email, password, name은 필수입니다.' }, 400);
  }

  if (body.password.length < 8) {
    return c.json({ error: '비밀번호는 최소 8자 이상이어야 합니다.' }, 400);
  }

  const db = c.env.DB;

  // 이메일 중복 확인
  const existingUser = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(body.email)
    .first();

  if (existingUser) {
    return c.json({ error: '이미 등록된 이메일입니다.' }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const accountId = generateId();
  const userId = generateId();
  const passwordHash = await hashPassword(body.password);

  // 트랜잭션: account + user + account_users 생성
  const stmts = [
    db
      .prepare(
        'INSERT INTO accounts (id, name, plan, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        accountId,
        body.account_name || body.name,
        'free',
        'active',
        now,
        now,
      ),

    db
      .prepare(
        'INSERT INTO users (id, account_id, email, password_hash, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(userId, accountId, body.email, passwordHash, body.name, 'admin', 'active', now, now),

    db
      .prepare(
        'INSERT INTO account_users (account_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
      )
      .bind(accountId, userId, 'owner', now),
  ];

  try {
    await db.batch(stmts);
  } catch (err) {
    console.error('회원가입 실패:', err);
    return c.json({ error: '회원가입 처리 중 오류가 발생했습니다.' }, 500);
  }

  // 토큰 발급
  const accessExpiresIn = parseInt(c.env.JWT_ACCESS_EXPIRES_IN || '900', 10);
  const refreshExpiresIn = parseInt(
    c.env.JWT_REFRESH_EXPIRES_IN || '604800',
    10,
  );

  const accessToken = await createAccessToken(
    {
      id: userId,
      email: body.email,
      name: body.name,
      role: 'admin',
      account_id: accountId,
    },
    c.env.JWT_SECRET,
    accessExpiresIn,
  );

  const refreshToken = createRefreshToken();
  const refreshTokenHash = await sha256(refreshToken);
  const refreshTokenId = generateId();

  await db
    .prepare(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, device_info, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      refreshTokenId,
      userId,
      refreshTokenHash,
      body.device_info || null,
      now + refreshExpiresIn,
      now,
    )
    .run();

  return c.json(
    {
      user: {
        id: userId,
        email: body.email,
        name: body.name,
        role: 'admin',
        account_id: accountId,
      },
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: accessExpiresIn,
    },
    201,
  );
});

// ─────────────────────────────────────────
// POST /auth/login - 로그인
// ─────────────────────────────────────────
auth.post('/login', async (c) => {
  const body = await c.req.json<{
    email: string;
    password: string;
    device_info?: string;
  }>();

  if (!body.email || !body.password) {
    return c.json({ error: 'email과 password는 필수입니다.' }, 400);
  }

  const db = c.env.DB;

  const user = await db
    .prepare('SELECT * FROM users WHERE email = ? AND status = ?')
    .bind(body.email, 'active')
    .first<UserRow>();

  if (!user || !user.password_hash) {
    return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }

  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) {
    return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const accessExpiresIn = parseInt(c.env.JWT_ACCESS_EXPIRES_IN || '900', 10);
  const refreshExpiresIn = parseInt(
    c.env.JWT_REFRESH_EXPIRES_IN || '604800',
    10,
  );

  const accessToken = await createAccessToken(
    user,
    c.env.JWT_SECRET,
    accessExpiresIn,
  );

  const refreshToken = createRefreshToken();
  const refreshTokenHash = await sha256(refreshToken);
  const refreshTokenId = generateId();

  await db
    .prepare(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, device_info, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      refreshTokenId,
      user.id,
      refreshTokenHash,
      body.device_info || null,
      now + refreshExpiresIn,
      now,
    )
    .run();

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      account_id: user.account_id,
    },
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: accessExpiresIn,
  });
});

// ─────────────────────────────────────────
// POST /auth/refresh - 토큰 갱신
// ─────────────────────────────────────────
auth.post('/refresh', async (c) => {
  const body = await c.req.json<{
    refresh_token: string;
    device_info?: string;
  }>();

  if (!body.refresh_token) {
    return c.json({ error: 'refresh_token은 필수입니다.' }, 400);
  }

  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await sha256(body.refresh_token);

  // 유효한 refresh token 조회
  const storedToken = await db
    .prepare(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
    )
    .bind(tokenHash, now)
    .first<RefreshTokenRow>();

  if (!storedToken) {
    return c.json(
      { error: '유효하지 않거나 만료된 리프레시 토큰입니다.' },
      401,
    );
  }

  // 사용자 정보 조회
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ? AND status = ?')
    .bind(storedToken.user_id, 'active')
    .first<UserRow>();

  if (!user) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 401);
  }

  // 기존 refresh token 폐기 (Rotation)
  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?')
    .bind(now, storedToken.id)
    .run();

  // 새 토큰 발급
  const accessExpiresIn = parseInt(c.env.JWT_ACCESS_EXPIRES_IN || '900', 10);
  const refreshExpiresIn = parseInt(
    c.env.JWT_REFRESH_EXPIRES_IN || '604800',
    10,
  );

  const newAccessToken = await createAccessToken(
    user,
    c.env.JWT_SECRET,
    accessExpiresIn,
  );

  const newRefreshToken = createRefreshToken();
  const newRefreshTokenHash = await sha256(newRefreshToken);
  const newRefreshTokenId = generateId();

  await db
    .prepare(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, device_info, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      newRefreshTokenId,
      user.id,
      newRefreshTokenHash,
      body.device_info || storedToken.device_info || null,
      now + refreshExpiresIn,
      now,
    )
    .run();

  return c.json({
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_in: accessExpiresIn,
  });
});

// ─────────────────────────────────────────
// POST /auth/logout - 로그아웃
// ─────────────────────────────────────────
auth.post('/logout', authMiddleware, async (c) => {
  const body = await c.req.json<{
    refresh_token?: string;
    logout_all?: boolean;
  }>();

  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const userId = c.get('userId');

  if (body.logout_all) {
    // 모든 디바이스에서 로그아웃
    await db
      .prepare(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      )
      .bind(now, userId)
      .run();

    return c.json({ message: '모든 세션에서 로그아웃되었습니다.' });
  }

  if (body.refresh_token) {
    // 특정 refresh token만 폐기
    const tokenHash = await sha256(body.refresh_token);
    await db
      .prepare(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND user_id = ?',
      )
      .bind(now, tokenHash, userId)
      .run();
  }

  return c.json({ message: '로그아웃되었습니다.' });
});

// ─────────────────────────────────────────
// GET /auth/me - 현재 사용자 정보
// ─────────────────────────────────────────
auth.get('/me', authMiddleware, async (c) => {
  const payload = c.get('jwtPayload');
  const db = c.env.DB;

  const user = await db
    .prepare(
      'SELECT id, account_id, email, name, role, status, created_at, updated_at FROM users WHERE id = ?',
    )
    .bind(payload.sub)
    .first<Omit<UserRow, 'password_hash'>>();

  if (!user) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
  }

  return c.json({ user, current_account_id: payload.account_id });
});

// ─────────────────────────────────────────
// GET /auth/accounts - 현재 사용자가 속한 팀(계정) 목록
// ─────────────────────────────────────────
auth.get('/accounts', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const rows = await db
    .prepare(
      `SELECT a.id, a.name
       FROM accounts a
       INNER JOIN account_users au ON a.id = au.account_id
       WHERE au.user_id = ? AND a.status = 'active'
       ORDER BY a.name ASC`,
    )
    .bind(userId)
    .all<{ id: string; name: string }>();

  const accounts = rows.results ?? [];
  return c.json({ accounts });
});

// ─────────────────────────────────────────
// POST /auth/switch-account - 현재 세션의 팀(계정) 전환
// ─────────────────────────────────────────
auth.post('/switch-account', authMiddleware, async (c) => {
  const body = await c.req.json<{ account_id: string }>();
  if (!body.account_id) {
    return c.json({ error: 'account_id는 필수입니다.' }, 400);
  }

  const userId = c.get('userId');
  const db = c.env.DB;

  const membership = await db
    .prepare(
      'SELECT 1 FROM account_users WHERE user_id = ? AND account_id = ?',
    )
    .bind(userId, body.account_id)
    .first();

  if (!membership) {
    return c.json({ error: '해당 팀에 대한 접근 권한이 없습니다.' }, 403);
  }

  const user = await db
    .prepare(
      'SELECT id, account_id, email, name, role FROM users WHERE id = ?',
    )
    .bind(userId)
    .first<Pick<UserRow, 'id' | 'account_id' | 'email' | 'name' | 'role'>>();

  if (!user) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
  }

  const accessExpiresIn = parseInt(c.env.JWT_ACCESS_EXPIRES_IN || '900', 10);
  const newAccessToken = await createAccessToken(
    {
      ...user,
      account_id: body.account_id,
    },
    c.env.JWT_SECRET,
    accessExpiresIn,
  );

  return c.json({
    access_token: newAccessToken,
    expires_in: accessExpiresIn,
  });
});

// ─────────────────────────────────────────
// PUT /auth/password - 비밀번호 변경
// ─────────────────────────────────────────
auth.put('/password', authMiddleware, async (c) => {
  const body = await c.req.json<{
    current_password: string;
    new_password: string;
  }>();

  if (!body.current_password || !body.new_password) {
    return c.json(
      { error: 'current_password와 new_password는 필수입니다.' },
      400,
    );
  }

  if (body.new_password.length < 8) {
    return c.json({ error: '새 비밀번호는 최소 8자 이상이어야 합니다.' }, 400);
  }

  const db = c.env.DB;
  const userId = c.get('userId');

  const user = await db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(userId)
    .first<Pick<UserRow, 'password_hash'>>();

  if (!user || !user.password_hash) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
  }

  const valid = await verifyPassword(body.current_password, user.password_hash);
  if (!valid) {
    return c.json({ error: '현재 비밀번호가 올바르지 않습니다.' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const newHash = await hashPassword(body.new_password);

  // 비밀번호 변경 + 모든 refresh token 폐기
  await db.batch([
    db
      .prepare(
        'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
      )
      .bind(newHash, now, userId),
    db
      .prepare(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      )
      .bind(now, userId),
  ]);

  return c.json({ message: '비밀번호가 변경되었습니다. 다시 로그인해주세요.' });
});

export default auth;
