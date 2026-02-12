/**
 * Cloudflare Workers 환경에서 Web Crypto API를 사용한 비밀번호 해싱
 * bcrypt 대신 PBKDF2 사용 (Workers에서 네이티브 지원)
 */

const ITERATIONS = 100_000;
const KEY_LENGTH = 64; // bytes
const ALGORITHM = 'PBKDF2';
const HASH = 'SHA-256';

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

/**
 * 비밀번호를 해싱합니다.
 * @returns "salt:hash" 형식의 문자열
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    ALGORITHM,
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: ALGORITHM,
      salt: salt,
      iterations: ITERATIONS,
      hash: HASH,
    },
    keyMaterial,
    KEY_LENGTH * 8
  );

  return `${bufferToHex(salt.buffer)}:${bufferToHex(derivedBits)}`;
}

/**
 * 비밀번호를 검증합니다.
 * @param password - 입력된 평문 비밀번호
 * @param storedHash - "salt:hash" 형식의 저장된 해시
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;

  const salt = hexToBuffer(saltHex);
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    ALGORITHM,
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: ALGORITHM,
      salt: salt,
      iterations: ITERATIONS,
      hash: HASH,
    },
    keyMaterial,
    KEY_LENGTH * 8
  );

  const derivedHex = bufferToHex(derivedBits);
  return derivedHex === hashHex;
}

/**
 * 랜덤 UUID 생성
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * 문자열의 SHA-256 해시를 생성합니다. (refresh token 해싱용)
 */
export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hash);
}
