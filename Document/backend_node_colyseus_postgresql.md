# Node.js·Colyseus·PostgreSQL 백엔드 아키텍처

> 상태: 기반 구현 완료, 전투·AI·건설 서버 권위화 진행 중
> 기준일: 2026-08-10
> 대상: 《5일 뒤 마왕》 3인 협동 웹 게임 MVP
> 목표 규모: 동시접속 10~20명, 한 파티 3명

## 1. 문서 목적

Cloudflare Worker/Vinext/D1 런타임은 제거되었고 Next.js Node, Colyseus, PostgreSQL 기반이 로컬에서 동작한다. 이 문서는 구현된 계약과 Phaser에 남은 전투 규칙을 서버로 이전하기 위한 완료 조건을 함께 정의한다.

```text
Browser
├─ HTTPS ───────> Next.js Node server ───────> PostgreSQL
│                 ├─ OAuth callback              ├─ users
│                 ├─ server session              ├─ auth_sessions
│                 ├─ REST API                    ├─ guestbook_entries
│                 └─ game-ticket JWT             ├─ matches
│                                                └─ match_players
│
└─ WSS ─────────> Colyseus game server ──────> PostgreSQL
                  ├─ matchmaking
                  ├─ party_room (3 players)
                  ├─ authoritative simulation
                  └─ final result transaction
```

초기 배포는 단일 Node.js 호스트에서 실행하지만 `web`, `game-server`, `postgres`는 별도 프로세스와 컨테이너로 분리한다. Redis는 Colyseus 프로세스가 둘 이상일 때만 추가한다.

## 2. 구현 상태와 완료 상태

| 영역 | 현재 구현 | 완료 상태 |
|---|---|---|
| 웹 런타임 | 표준 Next.js Node 런타임 | 완료 |
| 인증 | Cognito + Google OAuth 및 개발용 로컬 로그인 | 운영 Cognito 실계정 검증 |
| 브라우저 세션 | PostgreSQL 서버 세션 + HttpOnly 쿠키 | 완료 |
| 게임 서버 인증 | 90초 game-ticket JWT + Colyseus `static onAuth` | 키 교체 자동화 |
| REST | 인증·세션·방명록·전적 조회 | 완료 |
| DB | PostgreSQL + Drizzle ORM migration | 완료 |
| 게임 실행 | Colyseus가 Room·이동·시간을, Phaser가 전투·AI·건설을 소유 | 모든 최종 판정을 Colyseus가 소유 |
| 네트워크 | Colyseus client transport + versioned Zod protocol | Schema 상태를 Phaser 렌더링에 완전 연결 |
| 결과 저장 | Room 종료 transaction | 승패 판정 이전 후 보상 계산 추가 |
| 확장 | Redis 없는 단일 Colyseus 프로세스 | 필요 시 Redis 기반 다중 프로세스 |

### 2.1 제거한 Cloudflare 의존성 대체표

| 현재 대상 | 역할 | Node.js 대체 |
|---|---|---|
| `worker/index.ts` | Worker 진입점, 이미지 처리 | `next start`; 이미지 처리는 Next.js 기본 기능 |
| `vite.config.ts` Cloudflare 플러그인 | Worker/D1 로컬 바인딩 | 제거하고 `next.config.ts` 사용 |
| `.openai/hosting.json` | D1 바인딩 | `.env`의 `DATABASE_URL` |
| `db/index.ts`의 `cloudflare:workers` | 런타임 DB 접근 | `pg.Pool` + `drizzle-orm/node-postgres` |
| `drizzle-orm/d1` | SQLite ORM 드라이버 | `drizzle-orm/node-postgres` |
| `sqlite-core` 스키마 | D1 테이블 선언 | `pg-core` 스키마 선언 |
| `chatgpt-auth.ts` | 플랫폼 헤더 인증 | Cognito callback + 서버 세션 |
| `@cloudflare/workers-types` | Worker 타입 | Node.js·`pg` 타입 |
| Wrangler 빌드/실행 명령 | 로컬/배포 런타임 | Next.js, Colyseus, Docker Compose |
| Worker 기반 SSR 테스트 | Worker `fetch()` 호출 | 실제 Node 서버 또는 Route Handler 통합 테스트 |

## 3. 목표 저장소 구조와 책임

```text
apps/
├─ web/                         Next.js UI, OAuth, REST, BFF
└─ game-server/                 Colyseus 서버와 Room

packages/
├─ game-core/                   Phaser 비의존 순수 게임 규칙
├─ protocol/                    Zod 입력 스키마와 공유 타입
├─ db/                          Drizzle 스키마, migration, repository
└─ auth/                        세션·JWT 발급/검증 공통 코드
```

- `apps/web`은 HTML 렌더링, OAuth callback, 서버 세션, 방명록과 전적 조회를 소유한다.
- `apps/game-server`는 매치메이킹, Room 생명주기, 입력 검증, 게임 상태, 결과 확정을 소유한다.
- `packages/game-core`는 Phaser, React, Colyseus, DB를 import하지 않는다.
- `packages/protocol`은 클라이언트와 서버가 공유하는 유일한 네트워크 계약이다.
- `packages/db`는 두 서버가 공유하지만 HTTP나 Room 타입을 import하지 않는다.
- `packages/auth`는 쿠키 세션과 game-ticket 로직을 제공하며 UI에 의존하지 않는다.

## 4. 인증과 세션

### 4.1 OAuth 로그인 흐름

OAuth 제공자는 Google 하나이며 Cognito User Pool Lite가 federation과 기본 토큰 발급을 담당한다. 흐름은 Authorization Code + PKCE로 고정한다.

```text
1. Browser -> GET /api/auth/login?returnTo=/
2. Next.js -> state, nonce, code_verifier 생성
3. Next.js -> PKCE/상태 정보를 10분 만료 서명 쿠키에 저장
4. Browser -> Cognito Managed Login -> Google
5. Cognito -> GET /api/auth/callback?code=...&state=...
6. Next.js -> state/nonce 검증, code 교환
7. Next.js -> Cognito sub 기준 users upsert
8. Next.js -> auth_sessions 생성
9. Browser <- 불투명 세션 쿠키 설정 후 검증된 returnTo로 303 redirect
```

`returnTo`는 `/`로 시작하는 동일 오리진 상대 경로만 허용하고 `//`, 로그인, callback, logout 경로는 `/`로 치환한다.

### 4.2 서버 세션

- 쿠키 이름: `__Host-fdm_session`
- 속성: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`
- 쿠키 값: 256비트 CSPRNG 세션 원문을 base64url로 인코딩한 값
- DB 저장: 세션 원문이 아니라 `SHA-256(session)` 해시
- 기본 세션 수명: 7일
- 유휴 세션 수명: 마지막 사용 후 24시간
- 한 사용자당 활성 세션: 최대 5개; 초과 시 가장 오래된 세션부터 폐기
- Cognito refresh token: `AUTH_SESSION_ENCRYPTION_KEY`로 AES-256-GCM 암호화 후 DB 저장
- 로그아웃: 현재 세션을 DB에서 폐기하고 쿠키 만료
- 사용자 전체 로그아웃: 사용자의 모든 세션을 폐기

REST 인증은 세션 쿠키로 처리한다. 브라우저에 Cognito access/refresh token을 노출하거나 `localStorage`에 저장하지 않는다.

### 4.3 게임 접속 티켓

`POST /api/game-ticket`은 유효한 서버 세션과 CSRF 검증 후 90초 만료 RS256 JWT를 반환한다.

```json
{
  "token": "<jwt>",
  "expiresAt": "2026-08-10T12:34:56.000Z"
}
```

JWT 필수 claim:

| claim | 값 |
|---|---|
| `iss` | `five-days-web` |
| `aud` | `five-days-game-server` |
| `sub` | 내부 `users.id` UUID |
| `exp` | 발급 후 90초 |
| `iat` | 발급 시각 |
| `jti` | 매번 새 UUID |
| `scope` | `room:join` |
| `protocolVersion` | 현재 프로토콜 정수 버전 |
| `displayName` | 서버 검증된 표시 이름 |

개인키는 web 서버에만 두고 game-server에는 공개키만 배포한다. `kid`를 JWT header에 포함하고 현재 키와 직전 키를 동시에 검증할 수 있게 해 무중단 키 교체를 지원한다.

Colyseus는 Room 생성 전에 `static onAuth`에서 서명과 모든 필수 claim을 검증한다. MVP 단일 프로세스에서는 사용된 `jti`를 만료 시각까지 메모리에 보관해 재사용을 거부한다. 다중 프로세스 전환 시 이 저장소를 Redis TTL key로 교체한다.

## 5. 공개 REST 계약

모든 응답은 JSON이며 오류 형식은 다음으로 통일한다.

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "로그인이 필요합니다.",
    "requestId": "uuid"
  }
}
```

| Method | Path | 인증 | 동작 |
|---|---|---|---|
| `GET` | `/api/auth/login` | 없음 | PKCE 로그인 시작 후 Cognito로 redirect |
| `GET` | `/api/auth/callback` | OAuth state | code 교환, 사용자/세션 생성 |
| `POST` | `/api/auth/logout` | 세션 + CSRF | 현재 세션 폐기 |
| `GET` | `/api/session` | 선택 | `{ viewer: null }` 또는 사용자 공개 정보 반환 |
| `POST` | `/api/game-ticket` | 세션 + CSRF | 90초 Colyseus JWT 발급 |
| `GET` | `/api/guestbook` | 없음 | 최근 8개 공개 방명록 조회 |
| `POST` | `/api/guestbook` | 세션 + CSRF | 2~180자 방명록 생성 |
| `GET` | `/api/runs` | 세션 | 자신의 최근 10개 매치 결과 조회 |

기존 `POST /api/runs`는 제거한다. 결과는 클라이언트가 아닌 Colyseus가 직접 DB transaction으로 저장한다.

### 5.1 상태 코드

- `200`: 조회/로그아웃/티켓 발급 성공
- `201`: 방명록 생성 성공
- `303`: OAuth 로그인·callback redirect
- `400`: JSON 또는 입력 스키마 오류
- `401`: 로그인 또는 게임 티켓 오류
- `403`: CSRF, Origin, 권한 오류
- `409`: 중복 세션, 중복 결과 등 충돌
- `429`: rate limit
- `503`: DB 또는 인증 제공자 일시 장애

### 5.2 CSRF와 rate limit

- 상태 변경 REST 요청은 세션 쿠키와 함께 double-submit CSRF token을 요구한다.
- `Origin`이 설정된 요청은 허용 목록과 정확히 일치해야 한다.
- 로그인 시작: IP당 분당 10회
- game-ticket: 사용자당 분당 10회
- 방명록 작성: 사용자당 30초에 1회, IP당 분당 10회
- REST body 최대 크기: 16KiB
- 초기 단일 서버 rate limit 저장소는 메모리이며 다중 서버 전환 시 Redis로 이동한다.

## 6. Colyseus 계약

### 6.1 Room 정책

| 항목 | 값 |
|---|---|
| Room type | `party_room` |
| 최대 인원 | 3명 |
| 최소 시작 인원 | 1명(MVP 테스트), 운영 기본 3명 |
| 서버 simulation | 20Hz, 고정 50ms step |
| 상태 patch | Colyseus Schema 기본 patch, 최대 20Hz |
| 재접속 유예 | 20초 |
| 게임 최대 시간 | 35분 |
| 빈 Room | 즉시 dispose |
| protocol version 불일치 | join 거부 |

클라이언트 한 명당 활성 Room 연결은 하나만 허용한다. 새 연결이 인증되면 이전 연결을 `DUPLICATE_LOGIN` 코드로 종료한다.

### 6.2 메시지 envelope

모든 클라이언트 입력은 Zod로 검증하며 공통 envelope를 사용한다.

```ts
type ClientCommand<TType extends string, TPayload> = {
  v: number;
  type: TType;
  seq: number;
  clientTime: number;
  payload: TPayload;
};
```

- `v`: protocol version
- `seq`: 연결별 0부터 증가하는 정수
- `clientTime`: 관측/로그용이며 판정 시간으로 신뢰하지 않음
- 서버는 마지막 처리 `seq` 이하를 중복으로 폐기한다.
- 단일 메시지 직렬화 크기는 4KiB 이하로 제한한다.
- 사용자당 초당 30개를 초과하면 경고하고 반복 초과 시 연결을 종료한다.

### 6.3 클라이언트 명령

| type | payload | 검증 |
|---|---|---|
| `player.input` | 이동축 `x/y`, 조준각, 입력 bitmask | 축 -1~1, 정규화, 유효 bit만 허용 |
| `skill.cast` | `skillId`, 조준점 | 보유 스킬, cooldown, 거리, 생존 여부 |
| `build.place` | `buildingId`, grid 좌표 | 비용, 격자, 충돌, 경로 유효성 |
| `build.upgrade` | `structureId` | 소유 Room, 거리, 최대 레벨, 비용 |
| `upgrade.choose` | `draftId`, `upgradeId` | 서버가 발급한 현재 draft에 포함 |
| `room.ready` | 준비 여부 | 로비 phase에서만 허용 |

`enter-boss`, `return-base`, `restart`와 같은 기존 UI 명령은 서버 phase와 웨이포인트 규칙을 통과한 의도 명령으로 재정의한다. 클라이언트는 HP, 피해, 골드, XP, 타이머, 승패 또는 결과 통계를 직접 전송하지 않는다.

### 6.4 서버 상태와 이벤트

Colyseus Schema state의 최소 루트:

```ts
type PartyRoomState = {
  protocolVersion: number;
  matchId: string;
  phase: "lobby" | "day" | "night" | "standby" | "boss" | "ended";
  day: number;
  serverTime: number;
  phaseEndsAt: number;
  baseHp: number;
  gold: number;
  players: MapSchema<PlayerState>;
  enemies: MapSchema<EnemyState>;
  structures: MapSchema<StructureState>;
};
```

서버 상태에는 UI에 필요한 권위 값만 포함한다. 고빈도 투사체는 가능한 경우 `patternId`, seed, 시작 시각 이벤트로 재생하고 서버가 피격만 확정한다. 숨겨야 하는 드롭 테이블, 미선택 upgrade 후보, AI 내부 타깃은 state에 넣지 않는다.

### 6.5 서버 권위와 클라이언트 예측

- 서버 소유: 시간, phase, 좌표 유효성, 적 AI, 스폰, 공격 대상, 피해, HP, 골드, XP, 드롭, 건설, upgrade draft, 승패.
- 클라이언트 소유: 입력 수집, 화면 렌더링, 카메라, 사운드, 이펙트.
- 클라이언트 예측: 로컬 플레이어 이동과 즉시 이펙트만 허용.
- 보정: 서버 위치와 오차가 작으면 100ms 내 보간하고 임계치를 넘으면 즉시 스냅한다.
- 서버는 한 프레임 delta를 최대 100ms로 제한하고 누적 지연을 여러 fixed step으로 처리한다.

### 6.6 이탈과 재접속

- 예기치 않은 연결 종료는 `onDrop`에서 20초 재접속을 허용한다.
- 재접속 중 캐릭터는 AI가 제어하되 upgrade 선택과 보상 소비는 하지 않는다.
- 20초 내 복귀하면 동일 player state에 재연결한다.
- 유예 만료 후에도 Room은 진행하며 해당 플레이어를 AI 동료로 유지한다.
- 모든 사람이 이탈하면 20초 유예 후 match를 `abandoned`로 끝내고 저장한다.
- 프로세스 장애 시 메모리 Room 복원은 MVP 범위 밖이다. 매치가 사라질 수 있음을 운영 제한으로 명시한다.

## 7. PostgreSQL 모델

모든 PK는 `uuid`, 시각은 `timestamp with time zone`, 금액/통계는 범위가 정해진 `integer`를 사용한다.

### 7.1 `users`

| 컬럼 | 제약 |
|---|---|
| `id` | PK, UUID |
| `cognito_sub` | NOT NULL, UNIQUE, 변경 불가 |
| `email` | NOT NULL |
| `display_name` | NOT NULL, 1~60자 |
| `created_at` | NOT NULL, now |
| `updated_at` | NOT NULL, now |

인증 식별자는 이메일이 아니라 `cognito_sub`다. 이메일은 변경될 수 있으므로 FK나 PK로 사용하지 않는다.

### 7.2 `auth_sessions`

| 컬럼 | 제약 |
|---|---|
| `id` | PK, UUID |
| `user_id` | FK users, NOT NULL, index |
| `token_hash` | NOT NULL, UNIQUE |
| `encrypted_refresh_token` | NOT NULL |
| `expires_at` | NOT NULL, index |
| `last_seen_at` | NOT NULL |
| `revoked_at` | nullable |
| `created_at` | NOT NULL, now |

### 7.3 `guestbook_entries`

기존 필드를 유지하되 `author_id`를 `users.id` FK로 바꾼다. 사용자 탈퇴 후에도 기록을 유지하기 위해 삭제는 `ON DELETE SET NULL`로 처리하고 표시 이름 snapshot은 그대로 둔다.

### 7.4 `matches`

| 컬럼 | 제약 |
|---|---|
| `id` | PK, UUID; game-server가 Room 생성 시 생성 |
| `room_id` | NOT NULL, UNIQUE |
| `mode` | `prototype` 또는 `full` |
| `difficulty` | `easy`, `normal`, `hard` |
| `state` | `running`, `victory`, `defeat`, `abandoned`, `server_error` |
| `seed` | NOT NULL, bigint |
| `protocol_version` | NOT NULL |
| `server_version` | NOT NULL |
| `started_at` | NOT NULL |
| `ended_at` | nullable |
| `duration_seconds` | nullable |
| `day` | 1~5 |
| `result_reason` | 최대 240자 |

### 7.5 `match_players`

| 컬럼 | 제약 |
|---|---|
| `id` | PK, UUID |
| `match_id` | FK matches, NOT NULL |
| `user_id` | FK users, NOT NULL |
| `hero_class` | NOT NULL |
| `level`, `team_power` | NOT NULL, 0 이상 |
| `damage`, `boss_damage`, `kills`, `deaths` | NOT NULL, 0 이상 |
| `structures_built`, `gold_spent`, `gates_destroyed` | NOT NULL, 0 이상 |
| `joined_at`, `left_at` | 시각 |
| `disconnected` | NOT NULL, boolean |

`UNIQUE(match_id, user_id)`로 결과 중복을 차단하고 `(user_id, joined_at DESC)` 인덱스로 전적 조회를 지원한다.

### 7.6 결과 transaction

Room 종료 시 다음 작업을 하나의 Drizzle transaction으로 수행한다.

1. `matches.id`를 잠그고 상태가 `running`인지 확인한다.
2. `matches` 최종 상태와 종료 시각을 갱신한다.
3. 각 `match_players` 통계를 upsert한다.
4. 향후 메타 보상이 생기면 같은 transaction 안에서 지급한다.
5. 이미 종료된 match면 기존 결과를 반환하고 다시 지급하지 않는다.

게임 tick, 위치, 탄막, 적 AI 상태는 PostgreSQL에 매 tick 저장하지 않는다.

## 8. 마이그레이션 정책

- TypeScript `pg-core` schema가 source of truth다.
- 개발자는 `drizzle-kit generate --name <name>`으로 SQL을 생성한다.
- 생성 SQL과 snapshot을 코드 리뷰하고 Git에 포함한다.
- 운영 배포는 `drizzle-kit migrate`만 사용하며 `push`를 사용하지 않는다.
- 배포 전 `pg_dump`를 만들고 migration 실패 시 애플리케이션 전환을 중단한다.
- 컬럼 삭제·rename은 expand/migrate/contract 세 단계로 나눠 이전 버전 롤백을 가능하게 한다.
- migration은 단일 one-shot 프로세스만 실행하고 web/game 컨테이너가 동시에 실행하지 않는다.

## 9. 보안 정책

- 모든 외부 통신은 HTTPS/WSS를 사용한다.
- OAuth `state`, `nonce`, PKCE를 모두 검증하고 redirect URI는 고정 목록만 허용한다.
- 세션 원문, JWT, OAuth code, refresh token, 이메일은 로그에 남기지 않는다.
- refresh token과 JWT private key는 서로 다른 키로 보호한다.
- DB 계정은 애플리케이션용과 migration용을 분리한다. 앱 계정에는 DDL 권한을 주지 않는다.
- PostgreSQL 포트는 외부에 공개하지 않는다.
- 방명록은 plain text로 저장하고 React text node로 렌더링한다. HTML을 허용하지 않는다.
- 모든 REST payload와 Colyseus message는 런타임 스키마로 검증한다.
- 클라이언트가 제출한 사용자 ID, 표시 이름, 통계, 보상 값은 신뢰하지 않는다.
- 에러 응답은 내부 stack, SQL, 토큰 검증 세부사항을 포함하지 않는다.

## 10. 관측성과 운영

구조화 JSON 로그 공통 필드:

```text
timestamp, level, service, environment, requestId,
userId, roomId, matchId, event, durationMs, errorCode
```

민감정보는 값 자체를 기록하지 않고 존재 여부나 내부 UUID만 기록한다.

필수 metric:

- web: 요청 수, 상태 코드, p50/p95 latency, OAuth 실패, DB pool 대기
- game: 활성 Room/연결 수, tick duration, event-loop lag, 메시지 거부, 재접속
- DB: query latency, pool 사용률, transaction 실패, 디스크 사용량
- host: CPU, memory, swap, disk, container restart

health endpoint:

- web `/api/health/live`: 프로세스 생존만 확인
- web `/api/health/ready`: PostgreSQL `SELECT 1` 포함
- game `/health/live`: 프로세스 생존
- game `/health/ready`: 신규 Room 수용 가능 여부와 PostgreSQL 연결 확인

## 11. 구현 로드맵과 완료 조건

### 단계 1. Node.js 웹 런타임

- Cloudflare Worker, Wrangler, D1 바인딩을 제거한다.
- 표준 Next.js `dev/build/start`로 전환한다.
- 기존 SSR, Phaser 로딩, 방명록 UI가 유지된다.

완료 조건: Node.js에서 production build/start가 성공하고 기존 렌더링 smoke test가 통과한다.

### 단계 2. PostgreSQL

- workspace와 `packages/db`를 구성한다.
- D1 스키마를 위 PostgreSQL 모델로 교체하고 초기 migration을 생성한다.
- 방명록과 전적 API를 repository로 전환한다.

완료 조건: 빈 DB migration, CRUD, transaction rollback, 중복 match 결과 테스트가 통과한다.

### 단계 3. Cognito·세션·game-ticket

- Google/Cognito OAuth, callback, 세션, logout을 구현한다.
- 90초 JWT 발급과 키 rotation 검증을 구현한다.
- 기존 플랫폼 헤더 인증을 제거한다.

완료 조건: 정상 로그인, state/nonce 오류, 만료 세션, 로그아웃, 만료/재사용 game-ticket 테스트가 통과한다.

### 단계 4. `game-core`와 protocol 분리

- 현재 Phaser `GameScene`에서 시간, 진행, 피해, 경제, 승패 규칙을 순수 모듈로 추출한다.
- 입력과 snapshot 계약을 versioned Zod schema로 만든다.
- Phaser는 adapter와 렌더링만 소유한다.

완료 조건: 브라우저 없이 seed를 고정한 전체 세션 시뮬레이션 테스트가 재현 가능하게 통과한다.

### 단계 5. Colyseus

- `party_room`, 인증, 20Hz simulation, 상태 patch, 재접속을 구현한다.
- 브라우저에 Colyseus transport를 연결하되 local transport를 개발 옵션으로 유지한다.
- Room 종료 결과를 PostgreSQL에 저장한다.

완료 조건: 3클라이언트 접속, 중복 입력, 불법 스킬/건설, 재접속, 이탈 AI, 승패 저장 테스트가 통과한다.

### 단계 6. 배포와 운영

- Docker Compose, Caddy, GitHub Actions, migration job을 구성한다.
- Lightsail에 staging을 배포하고 health check, 백업, 복구, rollback을 검증한다.

완료 조건: 동시접속 20명, 여러 Room, 30분 실행에서 crash가 없고 월 1회 복구 훈련이 성공한다.

### 단계 7. 확장

다음 조건 중 하나를 만족할 때만 Redis/RDS/다중 서버로 전환한다.

- 단일 프로세스 CPU가 15분 이상 70% 초과
- event-loop lag p95가 50ms 초과
- Room 수용량 때문에 매치 생성 실패
- 단일 서버 장애 허용이 제품 요구를 충족하지 못함

전환 시 PostgreSQL은 RDS, Presence/Driver와 rate limit/jti 저장소는 Redis, 게임 서버는 여러 Colyseus 프로세스로 이동한다.

## 12. 테스트 매트릭스

| 영역 | 필수 시나리오 |
|---|---|
| OAuth | 정상, state/nonce/PKCE 오류, callback 재사용, provider 장애 |
| 세션 | 생성, 만료, 폐기, 최대 5개, 쿠키 변조, 전체 로그아웃 |
| JWT | 정상, 만료, 잘못된 issuer/audience/signature/version, jti 재사용 |
| REST | 인증·CSRF·Origin·body 크기·rate limit·DB 장애 |
| DB | 빈 DB migration, rollback, unique/FK, 중복 결과, backup restore |
| Room | 1/2/3명, 중복 접속, 20초 재접속, 이탈 AI, dispose |
| 게임 권위 | 속도 핵, cooldown 우회, 비용 부족, 불법 위치, 결과 위조 |
| 프로토콜 | 구버전 거부, 잘못된 type/payload, 중복/out-of-order seq |
| 부하 | 20명, 여러 Room, 30분, tick p95, memory 증가 추세 |
| 배포 | migration 실패, health 실패, 이전 image rollback, DB 복구 |

## 13. 환경 변수 계약

저장소에는 `.env.example`만 포함하고 실제 값은 GitHub Secrets와 서버의 권한 제한 파일에 둔다.

```text
NODE_ENV
APP_ORIGIN
GAME_SERVER_PUBLIC_URL
DATABASE_URL

COGNITO_REGION
COGNITO_USER_POOL_ID
COGNITO_CLIENT_ID
COGNITO_CLIENT_SECRET
COGNITO_ISSUER
COGNITO_REDIRECT_URI
AUTH_SESSION_ENCRYPTION_KEY
GAME_TICKET_PRIVATE_KEY_BASE64
GAME_TICKET_PUBLIC_KEY_BASE64
GAME_TICKET_ACTIVE_KID
PROTOCOL_VERSION

ALLOWED_ORIGINS
MINIMUM_PLAYERS
SERVER_VERSION
LOG_LEVEL
```

Google client secret은 Cognito에만 필요한 구성이면 애플리케이션 컨테이너에 주입하지 않는다. 실제 배포 시 Cognito 구성 방식에 맞춰 불필요한 두 변수를 제거한다.

## 14. 명시적 비범위

- MVP Room의 프로세스 장애 복원
- Redis, RDS, ALB, 다중 Availability Zone
- 3명을 초과하는 파티
- 관전자와 중도 참가
- 자체 비밀번호 회원가입
- 실시간 게임 상태의 PostgreSQL tick 저장
- 영구 랭킹·상점·결제

이 항목은 초기 구현 완료 조건에 포함하지 않는다.
