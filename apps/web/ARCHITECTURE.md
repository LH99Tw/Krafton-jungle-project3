# Node.js 웹·게임 아키텍처

> 이 문서는 현재 구현을 설명합니다. 전체 백엔드 계약과 남은 서버 권위화 로드맵은 [`Document/backend_node_colyseus_postgresql.md`](../../Document/backend_node_colyseus_postgresql.md), AWS 배포 런북은 [`Document/aws_lightsail_deployment.md`](../../Document/aws_lightsail_deployment.md)를 참고하세요.

## 실행 구조

```text
브라우저
├─ HTTPS/REST ─ Next.js Node 서버 ─ Drizzle ─ PostgreSQL
│                 └─ Cognito + Google OAuth
└─ WebSocket ─ Colyseus party_room ─ game-core
                         └─ 매치 결과 transaction ─ PostgreSQL
```

- Next.js는 화면, REST API, OAuth callback, HttpOnly 서버 세션을 담당합니다.
- Colyseus는 최대 3인의 Room, 90초 게임 티켓 검증, 입력 제한, 재접속, 20Hz 시뮬레이션과 결과 저장을 담당합니다.
- PostgreSQL은 사용자, 인증 세션, 방명록, 매치, 플레이어별 전적을 저장합니다.
- 초기 단일 서버에서는 Redis를 사용하지 않습니다. 여러 Colyseus 프로세스로 확장할 때 Presence/Driver 용도로만 추가합니다.

## 저장소 경계

```text
apps/web/
├─ app/api/auth/          OAuth login·callback·logout
├─ app/api/session/       현재 서버 세션
├─ app/api/game-ticket/   Colyseus 접속 JWT
├─ app/api/guestbook/     방명록 REST
├─ app/api/runs/          사용자 전적 조회
├─ src/features/          React UI
└─ src/game/
   ├─ client/             Phaser 캔버스
   ├─ content/            클래스·특성·밸런스 데이터
   ├─ domain/             UI와 로컬 런타임 타입
   ├─ runtime/            현재 플레이 가능한 Phaser 수직 슬라이스
   ├─ systems/            세션 상태기계와 성장 규칙
   └─ transport/          Colyseus 티켓·Room·입력 전송

apps/game-server/
├─ src/index.ts           HTTP/WebSocket 서버와 health check
├─ src/party-room.ts      인증·접속·명령·재접속·결과 저장
└─ src/state.ts           Colyseus Schema 동기화 상태

packages/
├─ auth/                  PKCE·OAuth state·JWT·Cognito 검증
├─ db/                    Drizzle schema·repository·migration
├─ game-core/             Phaser 비의존 결정론적 서버 규칙
└─ protocol/              버전이 있는 Zod 명령 계약
```

## 인증과 접속 흐름

1. 브라우저가 `/api/auth/login`에서 Cognito Authorization Code + PKCE를 시작합니다.
2. callback이 Cognito 토큰을 검증하고 PostgreSQL `auth_sessions`에 세션을 생성합니다.
3. 브라우저에는 임의 세션 ID와 CSRF 토큰만 쿠키로 전달합니다.
4. `/api/game-ticket`이 인증·CSRF를 확인하고 90초 RS256 JWT를 발급합니다.
5. Colyseus `static onAuth`가 서명과 `iss`, `aud`, `sub`, `exp`, `jti`, protocol version을 검증합니다.
6. 사용된 `jti`는 프로세스 메모리에서 만료 시각까지 보관해 재사용을 막습니다.

개발 환경의 `DEV_AUTH_BYPASS=true`는 Cognito 대신 로컬 사용자를 생성하지만 이후 세션·CSRF·게임 티켓 경로는 운영과 동일합니다.

## 현재 서버 권위 범위

| 영역 | 현재 소유자 | 상태 |
|---|---|---|
| 인증·세션·티켓 | Next.js/PostgreSQL | 구현 |
| Room·중복 접속·20초 재접속 | Colyseus | 구현 |
| 입력 sequence·검증·초당 제한 | Colyseus/protocol | 구현 |
| 플레이어 이동·페이즈 시간 | game-core | 구현 |
| 매치 생성·종료 결과 저장 | Colyseus/Drizzle | 구현 |
| 전투·적 AI·드롭·건설·승패 전체 | Phaser 로컬 런타임 | 이전 중 |

따라서 기존 싱글 플레이 수직 슬라이스는 그대로 플레이할 수 있지만, 모든 전투 판정을 신뢰할 수 있는 3인 멀티플레이로 만들려면 마지막 행을 `game-core`로 옮겨야 합니다. 미완성 서버 명령은 묵시적으로 승인하지 않고 protocol error를 반환합니다.

## 상태와 의존 방향

```text
protocol ← game-core ← Colyseus Room → db
    ↑                         ↑
web transport ────────────────┘
    ↓
Phaser renderer ↔ React HUD
```

Phaser와 React는 PostgreSQL에 직접 접근하지 않습니다. 게임 결과 POST는 브라우저에서 제거했고 Room 종료만 결과를 저장합니다. 실시간 엔티티 상태는 DB에 쓰지 않고 Room 메모리에 유지합니다.

## 운영 규칙

- Caddy만 80/443을 외부에 공개하고 web, game-server, PostgreSQL은 Docker 내부 네트워크에 둡니다.
- 매치 결과와 플레이어 결과는 하나의 transaction으로 저장하며 `match_id` unique constraint로 중복을 차단합니다.
- 스키마 변경은 `drizzle-kit generate`로 생성한 migration만 적용합니다.
- 토큰·이메일·refresh token은 로그에 남기지 않습니다.
- Redis, RDS, ALB, ElastiCache는 단일 Lightsail MVP 범위 밖입니다.

## 콘텐츠 확장

- 클래스 추가: `src/game/content/classes.ts`와 protocol의 `heroClassSchema`를 함께 변경합니다.
- 서버 전투 이전: Phaser 규칙에서 렌더링 의존성을 제거한 뒤 `packages/game-core` 테스트를 먼저 추가합니다.
- 건설 이전: 골드 차감, 그리드 점유, 경로 유효성을 하나의 서버 명령으로 검증합니다.
- 다중 서버 확장: Redis Presence/Driver를 추가하고 Room 프로세스 간 상태 공유가 아니라 매치메이킹과 위치 검색에만 사용합니다.
