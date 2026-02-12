# SocQuery SaaS Backend

SocQuery 에이전트 관리 SaaS의 백엔드 API 서버입니다.  
Cloudflare Workers + Hono + D1 기반으로 동작하며, AWS IoT Core와 연동하여 에이전트 장비를 프로비저닝합니다.

decembaek/socquery-saas-backend

---

## 기술 스택

| 항목          | 기술                                     |
| ------------- | ---------------------------------------- |
| 런타임        | Cloudflare Workers                       |
| 프레임워크    | Hono v4                                  |
| 데이터베이스  | Cloudflare D1 (SQLite)                   |
| 인증          | JWT (Access + Refresh Token Rotation)    |
| 비밀번호 해싱 | PBKDF2-SHA256 (Web Crypto API)           |
| AWS 연동      | aws4fetch (SigV4 서명)                   |
| IoT           | AWS IoT Core (Thing + 인증서 프로비저닝) |

---

## 프로젝트 구조

```
socquery-saas-backend/
├── src/
│   ├── index.ts                 # 앱 진입점 (Hono 라우터 + 미들웨어 + 에이전트 등록 API)
│   ├── types.ts                 # 타입 정의 (Bindings, JWT Payload, DB Row 타입)
│   ├── middleware/
│   │   └── auth.ts              # JWT 인증 미들웨어
│   ├── routes/
│   │   └── auth.ts              # 인증 라우트 (회원가입/로그인/토큰갱신/로그아웃)
│   └── utils/
│       ├── crypto.ts            # 비밀번호 해싱 (PBKDF2), SHA-256, UUID 생성
│       └── jwt.ts               # JWT 생성/검증 유틸리티
├── migrations/
│   └── 001_initial_schema.sql   # D1 초기 스키마 (accounts, users, refresh_tokens)
├── wrangler.jsonc               # Cloudflare Workers 설정
├── package.json
└── tsconfig.json
```

---

## 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          SocQuery SaaS 웹 콘솔                           │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  ┌───────────────────┐  │
│  │ 회원가입  │  │  로그인   │  │  장비 등록     │  │  장비 모니터링     │  │
│  └─────┬────┘  └─────┬────┘  └──────┬────────┘  └────────┬──────────┘  │
└────────┼─────────────┼──────────────┼─────────────────────┼─────────────┘
         │             │              │                     │
         ▼             ▼              ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    SocQuery SaaS Backend (이 프로젝트)                    │
│                    Cloudflare Workers + Hono + D1                        │
│                                                                          │
│  /api/v1/auth/*          → 인증 (JWT)                                    │
│  /api/v1/register-agent  → 장비 등록 (AWS IoT 프로비저닝)                 │
│  /api/v1/iot/webhook     → IoT Core 규칙 수신 (이벤트 처리)              │
│                                                                          │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                 ▼
┌──────────────────────┐          ┌──────────────────────────────────────┐
│   Cloudflare D1      │          │          AWS IoT Core                │
│                      │          │                                      │
│  accounts            │          │  1. 인증서 + 키 쌍 생성              │
│  users               │          │  2. Thing(사물) 생성                 │
│  account_users       │          │  3. Thing ↔ 인증서 연결              │
│  refresh_tokens      │          │  4. 정책(Policy) 할당               │
│  agents              │          │                                      │
│  agent_events        │          │  ── IoT Core 규칙 (Rules Engine) ──  │
│                      │          │  SELECT * FROM 'socquery/+/status'   │
└──────────────────────┘          │    → HTTPS Action                    │
         ▲                        │    → POST /api/v1/iot/webhook        │
         │                        └──────────────────┬───────────────────┘
         │  DB 업데이트                               │
         │  (상태, 이벤트 저장)                        │ mTLS (포트 8883)
         │                                            ▼
         │                        ┌──────────────────────────────────────┐
         │                        │        Client Agent (Go)             │
         │                        │                                      │
         └────────────────────────│  MQTT Publish                        │
           IoT Rule → Webhook     │  socquery/{tenant_id}/{thingName}/status                 │
           → Backend 처리         │  socquery/{tenant_id}/{thingName}/telemetry             │
                                  │  socquery/{tenant_id}/{thingName}/response                               │
                                  └──────────────────────────────────────┘
```

---

## 전체 동작 플로우

### 1단계: 사용자 인증

```
사용자 ──── POST /api/v1/auth/register ────→ 백엔드
       ←── { access_token, refresh_token } ──┘

사용자 ──── POST /api/v1/auth/login ───────→ 백엔드
       ←── { access_token, refresh_token } ──┘
```

### 2단계: 장비 등록 토큰 발급

```
웹 콘솔에서 "장비 등록" 클릭
  │
  ▼
백엔드가 등록 토큰 생성 (JWT 또는 일회용 토큰)
  │
  ▼
OS별 설치 커맨드 + 토큰을 사용자에게 제공

  ┌─────────────────────────────────────────────────────────┐
  │  Linux / macOS:                                         │
  │  curl -sL https://install.socquery.com | sh             │
  │  ./agent --token "eyJhbGciOi..."                        │
  │                                                         │
  │  Windows (PowerShell):                                  │
  │  irm https://install.socquery.com/win | iex             │
  │  .\agent.exe --token "eyJhbGciOi..."                    │
  └─────────────────────────────────────────────────────────┘
```

### 3단계: 에이전트 → 백엔드 등록 요청

```
Agent                              Backend                         AWS IoT Core
  │                                   │                                │
  │  POST /api/v1/register-agent      │                                │
  │  { token, machineId }             │                                │
  │ ─────────────────────────────────→│                                │
  │                                   │  1. 토큰 검증                   │
  │                                   │  2. 인증서+키 생성 요청          │
  │                                   │ ──────────────────────────────→│
  │                                   │←── certificatePem, privateKey  │
  │                                   │                                │
  │                                   │  3. Thing 생성                  │
  │                                   │ ──────────────────────────────→│
  │                                   │                                │
  │                                   │  4. Thing ↔ 인증서 연결         │
  │                                   │ ──────────────────────────────→│
  │                                   │                                │
  │                                   │  5. 정책 할당                   │
  │                                   │ ──────────────────────────────→│
  │                                   │                                │
  │←── { thingName, tenant_id,        │                                │
  │      certificatePem, privateKey,   │                                │
  │      iotEndpoint, region }         │                                │
  │                                   │                                │
  │  6. machineID로 AES-256-GCM       │                                │
  │     암호화 후 로컬 저장            │                                │
  │                                   │                                │
  │  7. 인증서로 mTLS MQTT 연결        │                                │
  │ ══════════════════════════════════════════════════════════════════→│
  │                                   │                                │
  │  8. socquery/{thingName}/status    │                                │
  │     { "status": "online" }         │                                │
  │ ══════════════════════════════════════════════════════════════════→│
```

### 4단계: 에이전트 통신 (등록 이후)

```
Agent                                              AWS IoT Core
  │                                                     │
  │  구독: socquery/{thingName}/command                  │
  │ ←══════════════════════════════════════════════════ │
  │                                                     │
  │  발행: socquery/{thingName}/status                   │
  │ ══════════════════════════════════════════════════→ │
  │                                                     │
  │  발행: socquery/{thingName}/telemetry                │
  │ ══════════════════════════════════════════════════→ │
  │                                                     │
  │  발행: socquery/{thingName}/response                 │
  │ ══════════════════════════════════════════════════→ │
  │                                                     │
  │  종료 시: { "status": "offline" } 발행 후 연결 해제  │
  │ ══════════════════════════════════════════════════→ │
```

### 5단계: IoT Core 규칙 → 백엔드 웹훅

에이전트가 MQTT로 발행한 메시지를 AWS IoT Core 규칙 엔진이 캐치하여 백엔드 HTTPS 엔드포인트로 전달합니다.

```
Agent                       AWS IoT Core                      Backend
  │                              │                                │
  │  PUBLISH                     │                                │
  │  socquery/{thingName}/status │                                │
  │  {"status":"online",...}     │                                │
  │ ════════════════════════════→│                                │
  │                              │                                │
  │                              │  ── Rules Engine ──            │
  │                              │  SQL: SELECT *,                │
  │                              │       topic(2) AS thingName    │
  │                              │       FROM 'socquery/+/status' │
  │                              │                                │
  │                              │  Action: HTTPS POST            │
  │                              │ ──────────────────────────────→│
  │                              │  POST /api/v1/iot/webhook      │
  │                              │  Header: X-IoT-Secret: {key}   │
  │                              │  Body: {                       │
  │                              │    "thingName": "device-abc",  │
  │                              │    "topic": "socquery/.../status",
  │                              │    "event": "status",          │
  │                              │    "payload": {                │
  │                              │      "status": "online",       │
  │                              │      "thingName": "...",       │
  │                              │      "tenantId": "..."         │
  │                              │    },                          │
  │                              │    "timestamp": 1707500000     │
  │                              │  }                             │
  │                              │                                │
  │                              │                                │  1. 시크릿 검증
  │                              │                                │  2. 이벤트 타입 라우팅
  │                              │                                │  3. agents 테이블 업데이트
  │                              │                                │  4. agent_events 기록
  │                              │                                │
  │                              │           ←── 200 OK ──────── │
  │                              │                                │
```

**같은 방식으로 telemetry, response 토픽도 처리:**

```
Agent                       AWS IoT Core                      Backend
  │                              │                                │
  │  PUBLISH                     │                                │
  │  socquery/{thingName}/       │                                │
  │    telemetry                 │  Rule: socquery/+/telemetry    │
  │  {"cpu":45,"mem":72,...}     │ ──────────────────────────────→│  agent_events INSERT
  │ ════════════════════════════→│                                │
  │                              │                                │
  │  PUBLISH                     │                                │
  │  socquery/{thingName}/       │                                │
  │    response                  │  Rule: socquery/+/response     │
  │  {"commandId":"...",         │ ──────────────────────────────→│  명령 실행 결과 저장
  │   "result":{...}}            │                                │
  │ ════════════════════════════→│                                │
```

---

## API 명세

### Base URL

```
/api/v1
```

---

### 인증 API (`/auth/*`)

#### `POST /auth/register` - 회원가입

| 항목 | 값     |
| ---- | ------ |
| 인증 | 불필요 |

**Request:**

```json
{
  "email": "user@example.com",
  "password": "mypassword123",
  "name": "홍길동",
  "account_name": "우리회사",
  "device_info": "web-chrome"
}
```

**Response (201):**

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "홍길동",
    "role": "admin",
    "account_id": "uuid"
  },
  "access_token": "eyJhbGciOi...",
  "refresh_token": "a1b2c3d4e5...",
  "expires_in": 900
}
```

**처리 로직:**

1. 이메일 중복 확인
2. 비밀번호 PBKDF2 해싱 (100,000 iterations)
3. account + user + account_users 트랜잭션 생성
4. Access Token (15분) + Refresh Token (7일) 발급

---

#### `POST /auth/login` - 로그인

| 항목 | 값     |
| ---- | ------ |
| 인증 | 불필요 |

**Request:**

```json
{
  "email": "user@example.com",
  "password": "mypassword123",
  "device_info": "web-chrome"
}
```

**Response (200):**

```json
{
  "user": {
    "id": "...",
    "email": "...",
    "name": "...",
    "role": "...",
    "account_id": "..."
  },
  "access_token": "eyJhbGciOi...",
  "refresh_token": "a1b2c3d4e5...",
  "expires_in": 900
}
```

---

#### `POST /auth/refresh` - 토큰 갱신

| 항목 | 값                              |
| ---- | ------------------------------- |
| 인증 | 불필요 (refresh_token으로 인증) |

**Request:**

```json
{
  "refresh_token": "a1b2c3d4e5...",
  "device_info": "web-chrome"
}
```

**Response (200):**

```json
{
  "access_token": "eyJhbGciOi...(새 토큰)",
  "refresh_token": "f6g7h8i9j0...(새 토큰)",
  "expires_in": 900
}
```

**처리 로직:**

- Refresh Token Rotation: 사용된 토큰은 즉시 폐기하고 새 토큰 발급
- 만료/폐기된 토큰으로 요청 시 401 반환

---

#### `POST /auth/logout` - 로그아웃

| 항목 | 값                                     |
| ---- | -------------------------------------- |
| 인증 | `Authorization: Bearer <access_token>` |

**Request:**

```json
{
  "refresh_token": "a1b2c3d4e5...",
  "logout_all": false
}
```

- `logout_all: true` → 모든 디바이스에서 로그아웃 (모든 refresh token 폐기)
- `refresh_token` 지정 → 해당 세션만 로그아웃

---

#### `GET /auth/me` - 현재 사용자 정보

| 항목 | 값                                     |
| ---- | -------------------------------------- |
| 인증 | `Authorization: Bearer <access_token>` |

**Response (200):**

```json
{
  "user": {
    "id": "uuid",
    "account_id": "uuid",
    "email": "user@example.com",
    "name": "홍길동",
    "role": "admin",
    "status": "active",
    "created_at": 1707500000,
    "updated_at": 1707500000
  }
}
```

---

#### `PUT /auth/password` - 비밀번호 변경

| 항목 | 값                                     |
| ---- | -------------------------------------- |
| 인증 | `Authorization: Bearer <access_token>` |

**Request:**

```json
{
  "current_password": "oldpassword",
  "new_password": "newpassword123"
}
```

**처리 로직:**

- 현재 비밀번호 검증 후 변경
- 변경 시 모든 refresh token 폐기 (재로그인 강제)

---

### 에이전트 등록 API

#### `POST /register-agent` - 장비 등록

| 항목 | 값                    |
| ---- | --------------------- |
| 인증 | 등록 토큰 (구현 예정) |

**Request (에이전트 → 백엔드):**

```json
{
  "token": "웹 콘솔에서 발급받은 등록 토큰",
  "machineId": "OS별 고유 머신 ID (SHA-256 해시)"
}
```

**Response (200):**

```json
{
  "success": true,
  "thingName": "socquery-agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "tenant_id": "account-uuid",
  "certificatePem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
  "iotEndpoint": "xxxxx-ats.iot.ap-northeast-2.amazonaws.com",
  "region": "ap-northeast-2"
}
```

**백엔드 처리 순서:**

| 단계 | 작업                      | AWS IoT API                                   |
| ---- | ------------------------- | --------------------------------------------- |
| 1    | 등록 토큰 검증            | -                                             |
| 2    | 인증서 + 키 쌍 생성       | `POST /keys-and-certificate?setAsActive=true` |
| 3    | Thing(사물) 생성          | `POST /things/{thingName}`                    |
| 4    | Thing ↔ 인증서 연결       | `PUT /thing-principals/{thingName}`           |
| 5    | 정책 할당                 | `PUT /target-policies/{policyName}`           |
| 6    | 에이전트에 연결 정보 반환 | -                                             |

---

### IoT 웹훅 API (`/iot/*`)

AWS IoT Core Rules Engine이 호출하는 엔드포인트입니다. 사용자가 직접 호출하지 않습니다.

#### `POST /iot/webhook` - IoT Core 이벤트 수신

| 항목   | 값                                       |
| ------ | ---------------------------------------- |
| 인증   | `X-IoT-Secret` 헤더 (공유 시크릿)        |
| 호출자 | AWS IoT Core Rules Engine (HTTPS Action) |

**Request (IoT Core → 백엔드):**

```json
{
  "thingName": "socquery-agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "event": "status",
  "ts": 1707500000000,
  "status": "online",
  "tenantId": "account-uuid"
}
```

> IoT Core SQL의 `SELECT *`로 원본 페이로드의 모든 필드가 포함되고,  
> `topic(2) AS thingName`, `'status' AS event`, `timestamp() AS ts`가 추가됩니다.

**이벤트 타입별 페이로드:**

**`event: "status"` - 상태 변경**

```json
{
  "thingName": "socquery-agent-xxx",
  "event": "status",
  "ts": 1707500000000,
  "status": "online",
  "tenantId": "account-uuid"
}
```

**`event: "telemetry"` - 시스템 메트릭**

```json
{
  "thingName": "socquery-agent-xxx",
  "event": "telemetry",
  "ts": 1707500000000,
  "cpu": 45.2,
  "memUsed": 72,
  "memTotal": 100,
  "diskUsed": 58,
  "diskTotal": 500,
  "uptime": 86400,
  "tenantId": "account-uuid"
}
```

**`event: "response"` - 명령 실행 결과**

```json
{
  "thingName": "socquery-agent-xxx",
  "event": "response",
  "ts": 1707500000000,
  "commandId": "command-uuid",
  "exitCode": 0,
  "output": "명령 실행 결과 텍스트",
  "tenantId": "account-uuid"
}
```

**Response (200):**

```json
{
  "ok": true
}
```

**백엔드 처리 로직:**

```
POST /api/v1/iot/webhook 수신
  │
  ├─ 1. X-IoT-Secret 헤더 검증 (불일치 시 401)
  │
  ├─ 2. thingName으로 agents 테이블 조회
  │     (존재하지 않으면 무시 또는 로그)
  │
  ├─ 3. event 타입별 분기
  │     │
  │     ├─ "status"
  │     │   ├─ agents.status = payload.status
  │     │   ├─ agents.last_seen_at = NOW
  │     │   └─ agent_events INSERT (type: "status")
  │     │
  │     ├─ "telemetry"
  │     │   ├─ agents.last_seen_at = NOW
  │     │   └─ agent_events INSERT (type: "telemetry", data: JSON)
  │     │
  │     └─ "response"
  │         ├─ agent_commands.status = "completed"
  │         ├─ agent_commands.result = payload.output
  │         ├─ agent_commands.exit_code = payload.exitCode
  │         └─ agent_events INSERT (type: "response")
  │
  └─ 4. 200 OK 반환
```

#### `GET /iot/webhook` - AWS IoT HTTPS 확인 (Confirmation)

AWS IoT Core가 HTTPS Action을 최초 설정할 때 확인 요청을 보냅니다.

| 항목   | 값                      |
| ------ | ----------------------- |
| 인증   | 불필요                  |
| 호출자 | AWS IoT Core (최초 1회) |

**처리:** 요청을 수신하면 200 OK를 반환하여 엔드포인트 소유를 확인합니다.

---

## 데이터베이스 스키마

### 현재 구현된 테이블

```sql
accounts              -- 테넌트(조직) 정보
├── id                -- UUID
├── name              -- 조직명
├── plan              -- free / pro / enterprise
├── status            -- active / inactive / deleted
├── created_at
└── updated_at

users                 -- 사용자
├── id                -- UUID
├── account_id        -- FK → accounts.id
├── email             -- UNIQUE
├── password_hash     -- PBKDF2 (salt:hash)
├── name
├── role              -- admin / member
├── status            -- active / inactive / deleted
├── created_at
└── updated_at

account_users         -- 계정-사용자 매핑 (멀티테넌트)
├── account_id        -- PK, FK → accounts.id
├── user_id           -- PK, FK → users.id
├── role              -- owner / admin / viewer
└── created_at

refresh_tokens        -- 리프레시 토큰 (Rotation 방식)
├── id                -- UUID
├── user_id           -- FK → users.id
├── token_hash        -- SHA-256 해시 (원본 미저장)
├── device_info       -- 디바이스 정보 (JSON)
├── expires_at
├── created_at
└── revoked_at        -- NULL이면 유효
```

### 추가 예정 테이블 (장비 관리 + 이벤트)

```sql
agents                     -- 등록된 에이전트 장비
├── id                     -- UUID
├── account_id             -- FK → accounts.id
├── thing_name             -- AWS IoT Thing 이름 (UNIQUE)
├── machine_id             -- 머신 고유 ID (해시)
├── certificate_arn        -- AWS 인증서 ARN
├── status                 -- online / offline / revoked
├── last_seen_at           -- 마지막 통신 시각 (웹훅으로 갱신)
├── created_at
└── updated_at

agent_events               -- 에이전트 이벤트 로그 (웹훅 수신 기록)
├── id                     -- UUID
├── agent_id               -- FK → agents.id
├── account_id             -- FK → accounts.id (조회 최적화)
├── type                   -- status / telemetry / response
├── data                   -- JSON (이벤트 페이로드 전체)
├── created_at
└── INDEX (agent_id, type, created_at DESC)

agent_commands             -- 에이전트에 전달한 명령 기록
├── id                     -- UUID (= commandId)
├── agent_id               -- FK → agents.id
├── account_id             -- FK → accounts.id
├── action                 -- 명령 타입 (scan, exec, update 등)
├── params                 -- JSON (명령 파라미터)
├── status                 -- pending / delivered / completed / failed / timeout
├── exit_code              -- 실행 결과 코드 (response 수신 시 업데이트)
├── result                 -- TEXT (실행 결과 출력)
├── created_at             -- 명령 생성 시각
├── completed_at           -- 실행 완료 시각
└── INDEX (agent_id, status, created_at DESC)

agent_registration_tokens  -- 장비 등록용 일회성 토큰
├── id                     -- UUID
├── account_id             -- FK → accounts.id
├── token_hash             -- 토큰 해시
├── used                   -- 사용 여부
├── expires_at
└── created_at
```

---

## 보안 설계

### 인증 토큰

| 항목           | 방식                                        |
| -------------- | ------------------------------------------- |
| Access Token   | JWT (HS256), 15분 만료                      |
| Refresh Token  | 랜덤 48바이트 hex, DB에 SHA-256 해시로 저장 |
| Token Rotation | refresh 사용 시 기존 폐기 + 새 토큰 발급    |
| 비밀번호 변경  | 모든 세션 강제 로그아웃                     |

### 비밀번호 해싱

| 항목      | 값                      |
| --------- | ----------------------- |
| 알고리즘  | PBKDF2                  |
| 해시 함수 | SHA-256                 |
| 반복 횟수 | 100,000                 |
| 키 길이   | 64 bytes                |
| Salt      | 16 bytes 랜덤           |
| 저장 형식 | `{salt_hex}:{hash_hex}` |

### 에이전트 보안

| 항목        | 방식                                            |
| ----------- | ----------------------------------------------- |
| 등록 토큰   | 일회용, 만료 시간 설정 (구현 예정)              |
| 인증서 전달 | HTTPS로 1회 전달, 에이전트가 로컬에 암호화 저장 |
| 로컬 저장   | AES-256-GCM 암호화 (machineID 기반 키 파생)     |
| MQTT 통신   | mTLS (상호 인증서 기반 TLS 1.2+, 포트 8883)     |

---

## MQTT 토픽 설계

| 토픽 패턴                        | 방향          | 용도                        |       IoT Rule 연동       | 페이로드 예시                                            |
| -------------------------------- | ------------- | --------------------------- | :-----------------------: | -------------------------------------------------------- |
| `socquery/{thingName}/status`    | Agent → Cloud | 상태 보고 (online/offline)  |             O             | `{"status":"online","thingName":"...","tenantId":"..."}` |
| `socquery/{thingName}/telemetry` | Agent → Cloud | 텔레메트리 (CPU, 메모리 등) |             O             | `{"cpu":45.2,"memUsed":72,"diskUsed":58,"uptime":86400}` |
| `socquery/{thingName}/response`  | Agent → Cloud | 명령 실행 결과 응답         |             O             | `{"commandId":"uuid","exitCode":0,"output":"..."}`       |
| `socquery/{thingName}/command`   | Cloud → Agent | 명령 전달                   | X (백엔드가 직접 Publish) | `{"commandId":"uuid","action":"scan","params":{...}}`    |

---

## AWS IoT 정책(Policy) 생성 (필수)

에이전트가 MQTT로 **연결(Connect)**하려면 아래 정책이 **반드시** 있어야 합니다.  
백엔드는 등록 시 인증서에 `Socquery_SaaS_Agent_policy`를 붙이므로, **이 이름으로 정책을 미리 생성**해 두어야 합니다.

**한 번만 실행하면 됩니다 (리전/계정당 1개):**

```bash
# policy-document.json 내용으로 정책 생성
aws iot create-policy \
  --policy-name Socquery_SaaS_Agent_policy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "iot:Connect",
        "Resource": "arn:aws:iot:*:*:client/${iot:Connection.Thing.ThingName}"
      },
      {
        "Effect": "Allow",
        "Action": "iot:Publish",
        "Resource": "arn:aws:iot:*:*:topic/socquery/*/${iot:Connection.Thing.ThingName}/*"
      },
      {
        "Effect": "Allow",
        "Action": "iot:Subscribe",
        "Resource": "arn:aws:iot:*:*:topicfilter/socquery/*/${iot:Connection.Thing.ThingName}/agent/command"
      },
      {
        "Effect": "Allow",
        "Action": "iot:Receive",
        "Resource": "arn:aws:iot:*:*:topic/socquery/*/${iot:Connection.Thing.ThingName}/agent/command"
      }
    ]
  }'
```

정책이 없으면 에이전트 연결 시 **EOF** 또는 **Connection Refused** 가 발생합니다.

---

## AWS IoT Core 규칙 설계

에이전트가 MQTT로 발행한 메시지를 IoT Core Rules Engine이 캐치하여 백엔드 HTTPS 엔드포인트로 전달합니다.

### 규칙 구성

총 3개의 규칙을 생성하며, 모두 같은 웹훅 엔드포인트(`/api/v1/iot/webhook`)로 전달합니다.  
토픽 경로의 3번째 세그먼트(`topic(3)`)로 이벤트 타입을 구분합니다.

#### 규칙 1: `socquery_agent_status`

```sql
SELECT *, topic(2) AS thingName, 'status' AS event, timestamp() AS ts
FROM 'socquery/+/status'
```

| 항목        | 값                                                    |
| ----------- | ----------------------------------------------------- |
| 트리거 토픽 | `socquery/+/status`                                   |
| 이벤트 타입 | `status`                                              |
| 용도        | 에이전트 online/offline 상태 변경 감지                |
| 백엔드 처리 | `agents.status` 업데이트 + `agents.last_seen_at` 갱신 |

#### 규칙 2: `socquery_agent_telemetry`

```sql
SELECT *, topic(2) AS thingName, 'telemetry' AS event, timestamp() AS ts
FROM 'socquery/+/telemetry'
```

| 항목        | 값                                                 |
| ----------- | -------------------------------------------------- |
| 트리거 토픽 | `socquery/+/telemetry`                             |
| 이벤트 타입 | `telemetry`                                        |
| 용도        | CPU, 메모리, 디스크 등 시스템 메트릭 수집          |
| 백엔드 처리 | `agent_events` INSERT + `agents.last_seen_at` 갱신 |

#### 규칙 3: `socquery_agent_response`

```sql
SELECT *, topic(2) AS thingName, 'response' AS event, timestamp() AS ts
FROM 'socquery/+/response'
```

| 항목        | 값                                           |
| ----------- | -------------------------------------------- |
| 트리거 토픽 | `socquery/+/response`                        |
| 이벤트 타입 | `response`                                   |
| 용도        | 명령 실행 결과 수신                          |
| 백엔드 처리 | `agent_commands.status` 업데이트 + 결과 저장 |

### 규칙 공통 Action 설정

모든 규칙의 HTTPS Action은 동일한 설정을 사용합니다:

| 항목         | 값                                                         |
| ------------ | ---------------------------------------------------------- |
| Action 타입  | HTTPS                                                      |
| URL          | `https://socquery.com/api/v1/iot/webhook`                  |
| 인증         | 커스텀 헤더 (`X-IoT-Secret`)                               |
| Content-Type | `application/json`                                         |
| 확인 URL     | 최초 설정 시 AWS가 확인 요청을 보냄 (백엔드에서 처리 필요) |

### AWS IoT 규칙 생성 CLI 예시

```bash
# 규칙 1: status
aws iot create-topic-rule \
  --rule-name socquery_agent_status \
  --topic-rule-payload '{
    "sql": "SELECT *, topic(2) AS thingName, '\''status'\'' AS event, timestamp() AS ts FROM '\''socquery/+/status'\''",
    "actions": [{
      "http": {
        "url": "https://socquery.com/api/v1/iot/webhook",
        "headers": [{"key": "X-IoT-Secret", "value": "${IOT_WEBHOOK_SECRET}"}],
        "confirmationUrl": "https://socquery.com/api/v1/iot/webhook"
      }
    }]
  }'

# 규칙 2: telemetry
aws iot create-topic-rule \
  --rule-name socquery_agent_telemetry \
  --topic-rule-payload '{
    "sql": "SELECT *, topic(2) AS thingName, '\''telemetry'\'' AS event, timestamp() AS ts FROM '\''socquery/+/telemetry'\''",
    "actions": [{
      "http": {
        "url": "https://socquery.com/api/v1/iot/webhook",
        "headers": [{"key": "X-IoT-Secret", "value": "${IOT_WEBHOOK_SECRET}"}],
        "confirmationUrl": "https://socquery.com/api/v1/iot/webhook"
      }
    }]
  }'

# 규칙 3: response
aws iot create-topic-rule \
  --rule-name socquery_agent_response \
  --topic-rule-payload '{
    "sql": "SELECT *, topic(2) AS thingName, '\''response'\'' AS event, timestamp() AS ts FROM '\''socquery/+/response'\''",
    "actions": [{
      "http": {
        "url": "https://socquery.com/api/v1/iot/webhook",
        "headers": [{"key": "X-IoT-Secret", "value": "${IOT_WEBHOOK_SECRET}"}],
        "confirmationUrl": "https://socquery.com/api/v1/iot/webhook"
      }
    }]
  }'
```

---

## 환경 변수

| 변수                     | 설명                    | 예시                                         |
| ------------------------ | ----------------------- | -------------------------------------------- |
| `DB`                     | D1 데이터베이스 바인딩  | (wrangler.jsonc에서 설정)                    |
| `JWT_SECRET`             | JWT 서명 키             | `wrangler secret put JWT_SECRET`             |
| `JWT_ACCESS_EXPIRES_IN`  | Access Token 만료 (초)  | `900` (15분)                                 |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 만료 (초) | `604800` (7일)                               |
| `AWS_ACCESS_KEY_ID`      | AWS IAM Access Key      | `wrangler secret put`                        |
| `AWS_SECRET_ACCESS_KEY`  | AWS IAM Secret Key      | `wrangler secret put`                        |
| `AWS_REGION`             | AWS 리전                | `ap-northeast-2`                             |
| `IOT_ATS_ENDPOINT`       | AWS IoT ATS 엔드포인트  | `xxxxx-ats.iot.ap-northeast-2.amazonaws.com` |
| `IOT_WEBHOOK_SECRET`     | IoT 웹훅 인증 시크릿    | `wrangler secret put IOT_WEBHOOK_SECRET`     |
| `RESEND_API_KEY`         | Resend API 키           | `wrangler secret put RESEND_API_KEY`         |
| `RESEND_FROM_EMAIL`      | 알람 발신자 이메일      | `alerts@socquery.com`                        |

---

## 개발 및 배포

### 로컬 개발

```bash
npm install
npm run dev
```

### 배포

```bash
npm run deploy
```

### D1 마이그레이션

```bash
# 로컬
wrangler d1 execute socquery-saas-d1 --local --file=./migrations/001_initial_schema.sql

# 프로덕션
wrangler d1 execute socquery-saas-d1 --remote --file=./migrations/001_initial_schema.sql
```

### 시크릿 설정

```bash
wrangler secret put JWT_SECRET
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put IOT_ATS_ENDPOINT
wrangler secret put IOT_WEBHOOK_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_FROM_EMAIL
```

---

## TODO (구현 예정)

**인증/라우팅:**

- [ ] auth 라우트를 index.ts에 마운트 (`app.route('/auth', auth)`)
- [ ] 에이전트 등록 API에 인증 미들웨어 적용

**장비 등록:**

- [ ] 장비 등록 토큰 발급 API (`POST /api/v1/agents/token`)
- [ ] 장비 등록 시 토큰 검증 + tenant_id 연결
- [ ] `agents`, `agent_events`, `agent_commands` 테이블 마이그레이션 추가

**장비 관리 API:**

- [ ] 장비 목록 조회 API (`GET /api/v1/agents`)
- [ ] 장비 상태 조회 API (`GET /api/v1/agents/:id`)
- [ ] 장비 이벤트 이력 조회 API (`GET /api/v1/agents/:id/events`)
- [ ] 장비 삭제 API (인증서 폐기 포함)

**IoT 웹훅:**

- [ ] `POST /api/v1/iot/webhook` 구현 (이벤트 수신 + 라우팅)
- [ ] `GET /api/v1/iot/webhook` 구현 (AWS IoT HTTPS 확인)
- [ ] `X-IoT-Secret` 시크릿 검증 미들웨어
- [ ] 이벤트 타입별 처리 (status → agents 업데이트, telemetry → events 저장, response → commands 업데이트)
- [ ] AWS IoT Core 규칙 3개 생성 (status, telemetry, response)

**명령 전달:**

- [ ] MQTT 명령 전달 API (`POST /api/v1/agents/:id/command`)
- [ ] 명령 이력 조회 API (`GET /api/v1/agents/:id/commands`)
- [ ] 명령 타임아웃 처리 (일정 시간 내 response 미수신 시 timeout)

**에이전트 텔레메트리:**

- [ ] 에이전트에 주기적 telemetry 발행 로직 추가 (Go client-agent)
- [ ] 에이전트에 command 수신 → 실행 → response 발행 로직 추가 (Go client-agent)
