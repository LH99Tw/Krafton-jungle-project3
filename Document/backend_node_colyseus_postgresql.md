# 0.2 Node.js·Colyseus·PostgreSQL 백엔드 아키텍처

> 기준일: 2026-08-10
> 상태: 백엔드 기반과 protocol v2는 구현, 멀티플레이 게임 규칙은 부분 통합
> 대상: 《5일 뒤 마왕》 솔로 1인 / 실제 사용자 3인 협동 MVP
> 관련 기획: `0.2버전_명세서.md`, `0.2버전_밸런스_데이터.md`, `0.2버전_변경사항.md`

## 1. 문서 목적

이 문서는 현재 저장소에 실제로 존재하는 Node.js·Colyseus·PostgreSQL 구조와 아직 목표에 머문 부분을 구분한다. “Colyseus에 연결된다”와 “3인 게임 전체가 서버 권위로 동작한다”를 같은 의미로 사용하지 않는다.

상태 용어:

| 상태 | 의미 |
|---|---|
| 구현 | 실제 코드 경로가 있고 핵심 동작이 연결됨 |
| 부분 구현 | 계약·Schema·일부 동작은 있으나 end-to-end 판정이 완성되지 않음 |
| 서버 규칙 구현 | 순수 game-core 규칙이 PartyRoom 시뮬레이션과 state에 연결됨 |
| 목표 | 설계와 완료 조건만 존재 |
| 운영 검증 필요 | 코드가 있으나 실제 Cognito/AWS/부하 환경 검증이 남음 |

## 2. 실제 실행 구조

```text
Browser
├─ HTTPS ───────> apps/web (Next.js Node)
│                 ├─ React lobby/HUD
│                 ├─ Phaser RoomGameScene
│                 │   ├─ network: server snapshot renderer
│                 │   └─ local: 별도 수직 슬라이스 simulation
│                 ├─ OAuth/guest/server session
│                 ├─ REST: session, guestbook, runs, game-ticket
│                 └─ Drizzle ───────────────────────────┐
│                                                       │
└─ WSS ─────────> apps/game-server (Colyseus)            │
                  ├─ party_room, auth, reconnect         │
                  ├─ 20Hz GameCore room/combat/progress │
                  ├─ protocol v2 validation              │
                  └─ final result repository ────────────┤
                                                          ▼
                                                    PostgreSQL
                                             users / auth_sessions
                                             guestbook_entries
                                             matches / match_players
```

초기 배포는 한 호스트에서 `caddy`, `web`, `game-server`, `postgres`를 별도 컨테이너로 실행한다. Redis, RDS, ALB는 현재 구현과 MVP 필수 범위에 없다.

## 3. 구현 상태 요약

| 영역 | 현재 코드 | 상태 | 다음 완료 조건 |
|---|---|---|---|
| 웹 런타임 | 표준 Next.js Node | 구현 | production smoke test 유지 |
| DB | PostgreSQL 17 + Drizzle schema/migration/repository | 구현 | 별도 DB integration/rollback test |
| Cognito OAuth | Authorization Code+PKCE route와 ID token 검증 | 구현 | 실제 Cognito 운영 계정 검증 |
| 개발 로그인 | `DEV_AUTH_BYPASS` 서버 세션 | 구현 | 개발 환경에만 제한 확인 |
| 공개 게스트 | `PUBLIC_PLAYTEST_ENABLED` guest session route | 구현 | 배포 rate limit·정리 정책 검증 |
| 서버 세션 | DB hash, HttpOnly 쿠키, CSRF | 구현 | session integration test 확대 |
| game-ticket | 90초 RS256 JWT, 1회 jti 메모리 검사 | 구현 | 다중 키 rotation·다중 프로세스 저장소 |
| REST | session/guestbook/runs/game-ticket/health | 구현 | REST rate/body 통합 제한 |
| protocol | strict Zod protocol v2와 session별 공통 seq 거부 | 구현 | phase·거리·소유권 검증 확대 |
| PartyRoom | solo/coop 옵션, max1/3, ready, lock, reconnect | 부분 구현 | 3-client E2E와 이탈 만료 정책 |
| 서버 시뮬레이션 | 룸 이동, 자동 공격, 정적/침공 AI, 자원, 정적 리스폰, phase/base | 부분 구현 | 스킬·건설·플레이어 부활·보스 패턴 |
| 0.2 맵/장비/성장 | game-core + PartyRoom 명령/state + property test | 서버 규칙 구현 | 클라이언트 표현과 3-client E2E |
| 확장 Schema | 발견 rooms/doors/enemies/waypoints와 개인 drops/draft를 실제 동기화 | 부분 구현 | structures lifecycle과 client 전체 소비 |
| 클라이언트 state 구독 | RoomGameScene의 room/player/enemy/drop 렌더, draft/equipment/waypoint/result view | 부분 구현 | 장비 비교·분해 UI와 3-client E2E |
| 전투·AI·드롭·건설 | network는 서버 기본 전투/AI만 소비; 스킬·건설은 준비 전 거부 | 부분 구현 | 스킬·건설·boss pattern과 모든 UI 연결 |
| 결과 저장 | 서버 결과 broadcast·overlay·전투 통계 transaction | 부분 구현 | 전체 기여 표시와 E2E 단일 저장 검증 |
| 배포 | Docker/Caddy/Lightsail 구성 파일 | 구현 | staging 배포·복구·부하 검증 |

## 4. 저장소 책임

```text
apps/
├─ web/                         Next.js UI, Phaser, OAuth, REST/BFF
└─ game-server/                 Colyseus HTTP/WebSocket 서버와 Room

packages/
├─ auth/                        OAuth 보조, 암호화, game-ticket
├─ db/                          PostgreSQL Drizzle schema/repository/migration
├─ game-core/                   Phaser 비의존 게임 규칙과 현재 기본 Core
└─ protocol/                    client/server 공용 Zod 계약
```

- `apps/web`은 DB에 직접 SQL을 쓰지 않고 `packages/db` repository를 사용한다.
- `apps/game-server`는 인증된 사용자 입력, Room 생명주기, 권위 상태와 결과 저장을 소유한다.
- `packages/game-core`는 Phaser·React·Colyseus·DB에 의존하지 않는다.
- `packages/protocol`의 schema가 네트워크 입력 타입의 원본이다.
- 실시간 entity 상태는 Room 메모리에 두며 매 tick PostgreSQL에 저장하지 않는다.

## 5. 웹 인증과 서버 세션

### 5.1 구현된 로그인 경로

1. 운영 후보: `/api/auth/login` → Cognito Managed Login/Google → `/api/auth/callback`.
2. 개발: 비운영 환경에서 `DEV_AUTH_BYPASS=true`이면 로컬 사용자 세션 생성.
3. 공개 테스트: 비운영 환경 또는 `PUBLIC_PLAYTEST_ENABLED=true`이면 `/api/auth/guest`가 1일 guest session 생성.

OAuth route는 state, nonce, PKCE verifier와 동일 origin `returnTo`를 검증한다. Cognito 실서비스 연동은 코드 존재와 별개로 운영 검증이 필요하다.

### 5.2 세션

- 운영 쿠키: `__Host-fdm_session`; 개발: `fdm_session`.
- `HttpOnly`, `SameSite=Lax`, 운영 `Secure`, `Path=/`.
- DB에는 세션 원문 대신 SHA-256 hash 저장.
- 기본 OAuth/개발 세션 7일, guest session 1일.
- 24시간 idle 이후 조회 거부.
- 사용자당 활성 세션 최대 5개, 초과분 revoke.
- refresh token 또는 guest marker는 AES-256-GCM으로 암호화.
- mutation은 `fdm_csrf` cookie와 `x-csrf-token`, 허용 Origin을 확인.

### 5.3 공개 guest의 현재 제약

- guest도 `users`와 `auth_sessions` row를 생성한다.
- guest email은 `.invalid` 주소이며 외부 발송에 사용하지 않는다.
- 자동 만료 row 청소, IP/user rate limit, guest 전적 보존 기간은 아직 구현 근거가 없다.
- production에서는 `PUBLIC_PLAYTEST_ENABLED`가 false이면 Google/Cognito 로그인으로 redirect한다.

## 6. 게임 접속 티켓

`POST /api/game-ticket`은 서버 세션과 CSRF 검증 후 90초 RS256 JWT를 발급한다.

필수 claim:

| claim | 값 |
|---|---|
| `iss` | `five-days-web` |
| `aud` | `five-days-game-server` |
| `sub` | 내부 user UUID |
| `jti` | 매번 새 UUID |
| `scope` | `room:join` |
| `protocolVersion` | 현재 2 |
| `displayName` | 서버 세션 사용자 표시명 |
| `iat`, `exp` | 발급/90초 만료 |

현재 game-server는 `static onAuth`에서 JWT와 Origin을 검증하고 사용된 `jti`를 프로세스 메모리에 보관한다.

현재 한계:

- public key 하나를 읽으므로 문서상 목표였던 현재/직전 키 동시 rotation은 아직 완성되지 않았다.
- 다중 game-server에서는 메모리 jti 집합을 공유하지 못한다. 확장 시 Redis TTL key가 필요하다.

## 7. REST 계약

| Method | Path | 인증 | 실제 동작 |
|---|---|---|---|
| GET | `/api/auth/login` | 없음 | Cognito 또는 개발 로그인 시작 |
| GET | `/api/auth/callback` | OAuth state | code 교환과 서버 세션 생성 |
| GET | `/api/auth/guest` | 환경 flag | 공개 테스트 guest session 생성 |
| POST | `/api/auth/logout` | 세션+CSRF | 현재 세션 revoke |
| GET | `/api/session` | 선택 | viewer 또는 null |
| POST | `/api/game-ticket` | 세션+CSRF | 90초 JWT 발급 |
| GET | `/api/guestbook` | 없음 | 최근 8개 |
| POST | `/api/guestbook` | 세션+CSRF | 2~180자 생성 |
| GET | `/api/runs` | 세션 | 본인 최근 10개 결과 |
| POST | `/api/runs` | — | 405; 클라이언트 결과 제출 거부 |
| GET | `/api/health/live` | 없음 | web process 생존 |
| GET | `/api/health/ready` | 없음 | DB 준비 상태 |

오류 형식은 `{ error: { code, message, requestId } }`다. REST 전역 body 16KiB 제한과 route별 rate limiter는 기존 문서의 목표였으며 현재 구현 완료로 간주하지 않는다.

## 8. protocol v2

### 8.1 RoomOptions

```ts
{
  heroClass: "swordsman" | "archer" | "mage";
  sessionMode: "prototype" | "full";
  difficulty: "easy" | "normal" | "hard";
  partyMode: "solo" | "coop";
  protocolVersion: 2;
}
```

- solo Room은 `maxClients=1`, 시작 요구 1명.
- coop Room은 `maxClients=3`, 시작 요구도 정확히 3명으로 코드에 고정돼 있다.
- Room 생성 옵션과 다른 party/session/difficulty로 join하면 409.
- 진행 시작 후 Room을 lock하고 신규 사용자를 거부한다.

### 8.2 명령 envelope

모든 schema는 strict object다.

```ts
{
  v: 2;
  seq: number;
  clientTime: number;
  type: string;
  payload: object;
}
```

| 명령 | schema | 서버 의미 처리 |
|---|---|---|
| `room.ready` | 구현 | 구현 |
| `player.input` | 구현 | 이동·aim 구현 |
| `skill.cast` | 구현 | `SKILL_NOT_READY` 거부 |
| `build.place` | 구현 | `BUILD_NOT_READY` 거부 |
| `build.upgrade` | 구현 | `BUILD_NOT_READY` 거부 |
| `upgrade.choose` | 구현 | draft ID·선택지 검증 후 적용 |
| `player.interact` | 구현 | drop·waypoint·인접 door 처리 |
| `travel.request` | 구현 | 활성·목적지·전원 위치 검증 후 5초 점유 |
| `recall.request` | 구현 | 활성 waypoint·전원 정족수 검증 후 base 방향 5초 점유 시작 |
| `equipment.equip` | 구현 | 소유자·동일 room·미획득 검증 후 장착 |

중요한 현재 한계:

- PartyRoom은 client session별 마지막 seq를 기록해 모든 명령의 중복·역순을 `STALE_SEQUENCE`로 거부한다.
- input은 GameCore에서도 user별 `lastSeq`를 다시 확인한다.
- 각 명령의 phase·물리 거리·대상 공개 범위 검증은 명령별로 강도가 달라 보강이 필요하다.
- 스킬과 건설은 schema만 허용하고 서버가 명시적으로 준비 전 오류를 반환한다.

### 8.3 전송 제한

- 메시지 직렬화 크기 4KiB 초과 시 거부.
- session ID 기준 초당 30개 초과 시 `RATE_LIMITED`.
- Colyseus WebSocket max payload 4KiB.
- `clientTime`은 관측용이며 판정 시각으로 신뢰하지 않는다.

## 9. PartyRoom과 GameCore

### 9.1 현재 구현

- Room 생성 시 match row와 random UUID seed 생성.
- 인증 사용자 중복 접속 시 기존 연결 종료.
- solo/coop에 따른 max/min 인원과 ready 시작.
- 시작 후 Room lock.
- 20Hz simulation과 최대 delta 100ms.
- 모든 command의 session별 단조 증가 seq와 초당 30개/4KiB 제한.
- 결정론적 3구역 5×5/15방 world와 room-local 이동·door 전환.
- cursor 원뿔 자동 공격, 피해·사망·전멸, 팀 XP와 개인 draft.
- 피격 후 반격하는 정적/히든 적, 밤 8초 간격 침공 적, base 피해.
- 발견한 자원 방마다 +1골드/5초와 일반 정적 적 prototype30/full90초 리스폰.
- 게이트 파괴, 연결·생존 사용자 전원 5초 waypoint 점유, 구역 이동과 boss room 진입.
- 활성 waypoint에서 같은 정족수/5초 규칙을 재사용하는 base recall.
- 개인 hidden drop, 자동 상위 장비 교체, 남은 drop의 소유권 기반 장착.
- day/night/standby, 5일 종료 패배, base 파괴 패배, 기본 boss HP/처치 승리.
- rooms/doors/enemies/waypoints/drops와 player 장비/draft를 Schema에 동기화.
- 공격 피해·boss 피해·처치·사망·게이트 파괴 기여 통계 누적.
- `onLeave`에서 입력을 0으로 만들고 비정상 이탈이면 20초 재접속을 시도.
- Room 생성 후 최대 35분이 지나면 abandoned로 종료.
- dispose 시 abandoned 결과 저장 시도.

### 9.2 아직 구현되지 않았거나 단순화된 핵심

- Q/E 스킬 효과와 button bitmask의 회피/스킬 판정.
- 개별 플레이어 부활 규칙.
- 히든 적의 투사체 패턴과 보스 공격·장판·소환·광폭화 패턴.
- 건설 배치·강화, 비용·충돌·경로 검증, `structures` lifecycle.
- room 내부 장애물 충돌과 더 정밀한 침공 적 이동 표현.
- 명령별 phase·물리 거리·대상 공개 범위 검증의 일관성.
- 20초 재접속 실패 후 avatar 제거·match 정족수 정책.
- 개인 drop·전투 event·미구현 규칙까지 포함한 Phaser lifecycle과 실제 3-client end-to-end.

AI 동료는 0.2 명세에서 금지한다. 연결 종료자를 AI로 전환한다는 이전 문서 규칙은 폐기됐다.

## 10. Colyseus Schema와 클라이언트 연결

### 10.1 정의된 Schema

Root에는 seed, phase, zone, day, server time, base, gold, team XP와 다음 map이 정의되어 있다.

- players
- rooms / doors
- enemies
- waypoints
- structures
- drops

Player에는 room ID, 좌표, HP, alive/connected, 장비 요약, 개인 upgrade draft가 정의돼 있다.

### 10.2 실제 동기화 범위

현재 `PartyRoom.syncState()`는 root와 player뿐 아니라 발견된 rooms/doors/enemies/waypoints를 GameCore 값으로 채우고, 개인 장비 요약과 upgrade draft, drops도 동기화한다. draft와 drop은 Colyseus `StateView`로 해당 사용자에게만 전달한다. `structures`는 건설 미구현으로 비어 있다.

클라이언트 `ColyseusTransport`는 player/root, 발견 rooms/doors/enemies/waypoints, 개인 draft·장비·drop과 terminal result를 view model로 변환하고 서버 20초 예약보다 짧은 18초 deadline 안에서 reconnect를 재시도한다. 현재 `createGame.ts`는 `RoomGameScene`을 유일한 실행 장면으로 사용하며, 이 장면은 network mode의 `update()`에서 로컬 session·전투·AI·경제 tick을 실행하지 않는다. 서버 room을 `RoomRenderer`로 전환하고 같은 방의 player/enemy와 소유자 drop을 state 위치로 표현하며, drop 클릭 equip·draft 선택·waypoint/travel/recall과 종료 결과를 UI 경계에 전달한다.

부분 구현으로 남은 클라이언트 경계:

- 장비 비교·확인·분해, 특수 옵션과 폐기 lifecycle UI.
- server skill/build가 없으므로 network mode의 Q/E/Space와 건설 기능.
- boss 공격 pattern/피격 표현과 전투 이펙트의 state/event 계약.
- server 개인별 기여 통계를 결과 overlay에 표시하는 별도 상세 payload.
- room 전환 보간·오류 복구와 실제 세 브라우저 동시 검증.

목표:

- 남은 structure/event를 Phaser 표현 객체에 일대일 매핑하고 장비 관리 UI를 완성.
- 위치 예측을 추가하더라도 HP·피해·경제는 server patch로 확정.
- 위치 오차는 보간하고 큰 오차는 snap.
- network mode snapshot-only 원칙을 회귀 테스트로 고정.

## 11. `game-core` 0.2 규칙

`packages/game-core/src/v02`에는 다음 순수 규칙이 구현돼 root export되며, `GameCore`와 `PartyRoom`이 일부를 실제 시뮬레이션에 사용한다.

- 결정론적 seed PRNG.
- 구역당 5×5/15방, 시작 `(0,4)`, 게이트 `(4,0)`, 히든 degree1 맵.
- 장비 rarity/slot과 개인 Legendary80/Mythic20 드롭.
- 레벨30, XP, 일반10종·클래스별 전직5종, 결정론적 3-choice draft.
- room-local 이동, 자동 공격, 정적/침공 AI, waypoint, 기본 boss와 결과 처리.

검증된 범위:

- 맵 1,000 seed × 3구역 property test.
- 드롭 20,000회 경계·분포 test.
- 3클래스 × 250 경로 × 레벨2~30 draft test.
- world 생성, room 전환, 자동 공격, 적 AI, draft, hidden drop, waypoint/boss, 침공 경로, 자원 생산, 리스폰, recall integration test.

PartyRoom과 기본 room/player/enemy/draft/equipment/waypoint 화면 연결까지 진행됐다. 개인 drop lifecycle 완결, 스킬·건설·플레이어 부활·보스 공격 패턴은 아직 남아 있다.

## 12. PostgreSQL

### 12.1 실제 테이블

| 테이블 | 용도 |
|---|---|
| `users` | Cognito/guest 식별자, email, 표시명 |
| `auth_sessions` | hash token, 암호화 refresh marker, 만료/revoke |
| `guestbook_entries` | 공개 방명록, 선택 author FK |
| `matches` | room, mode, difficulty, state, text seed, version, 결과 |
| `match_players` | 사용자별 클래스·레벨·기여 통계 |

현재 `matches`에는 `partyMode` 컬럼이 없다. 솔로/협동 결과를 구분해 분석하려면 migration이 필요하다.

### 12.2 결과 저장

`finalizeMatch()`는 match row를 `FOR UPDATE`로 잠그고 running 상태일 때만 종료 상태와 player 결과를 기록한다. `(match_id,user_id)` unique와 upsert가 중복 player 결과를 막는다.

제약:

- 기본 server combat는 damage/bossDamage/kills/deaths/gates를 누적한다. terminal state의 승패·사유와 최종 팀 집계 snapshot은 결과 overlay에 연결됐지만, 개인별 불변 결과 payload와 스킬·건설 통계는 아직 없다.
- DB repository 코드는 있으나 빈 DB migration, rollback, 동시 finalize의 별도 integration test는 현재 test 목록에 없다.

### 12.3 migration 정책

- `packages/db/src/schema.ts`가 원본.
- `drizzle-kit generate`로 SQL 생성 후 리뷰.
- 적용은 `drizzle-kit migrate`; 운영에서 schema `push` 사용 금지.
- migration은 compose의 one-shot `migrate` profile 한 곳에서 실행.
- 파괴적 변경은 expand/migrate/contract 단계로 분리.

## 13. 보안: 현재와 목표

### 13.1 현재 코드에 있는 방어

- OAuth state/nonce/PKCE와 안전한 return path.
- HttpOnly session, hash 저장, AES-256-GCM refresh 암호화.
- CSRF double-submit과 Origin allowlist.
- 90초 RS256 game-ticket, issuer/audience/version, jti 1회 사용.
- Colyseus Origin 검증, strict Zod, 4KiB, 초당 30개.
- 브라우저의 `POST /api/runs` 결과 제출 거부.
- DB unique/check/FK와 result transaction.

### 13.2 목표/보강 필요

- REST 로그인·guest·ticket·방명록 rate limit.
- REST 공통 body 크기 제한.
- 모든 command의 phase·거리·대상 공개 범위 검증 보강.
- guest 계정 정리와 악용 제한.
- key rotation과 secret rotation 절차.
- 구조화 로그의 민감정보 redaction test.
- 운영 DB 계정 DDL 분리와 backup restore 훈련.

## 14. 관측성과 운영

구현된 health endpoint:

- web `/api/health/live`, `/api/health/ready`.
- game `/health/live`, `/health/ready`.

목표 공통 로그 필드:

```text
timestamp, level, service, environment, requestId,
userId, roomId, matchId, event, durationMs, errorCode
```

활성 Room, 연결 수, tick p95, event-loop lag, rejected message, reconnect, DB latency, container restart metric은 운영 목표이며 현재 완비됐다고 간주하지 않는다.

## 15. 배포

저장소에는 다음 기반이 있다.

- `Dockerfile.web`, `Dockerfile.game`.
- `compose.yml`: Caddy/web/game-server/migrate/postgres.
- `compose.local.yml`: localhost:55432 PostgreSQL.
- Caddy HTTPS/WSS reverse proxy.
- Lightsail bootstrap/configure/deploy 문서와 workflow.

운영 완료를 주장하려면 staging에서 migration, health failure rollback, DB backup/restore, 3-client WebSocket, 20명 부하를 별도로 검증해야 한다.

## 16. 환경 변수

핵심 현재 계약:

```text
NODE_ENV
APP_ORIGIN
GAME_SERVER_PUBLIC_URL
DATABASE_URL
DATABASE_SSL
DB_POOL_MAX

DEV_AUTH_BYPASS
PUBLIC_PLAYTEST_ENABLED
AUTH_SESSION_ENCRYPTION_KEY
GAME_TICKET_PRIVATE_KEY_BASE64
GAME_TICKET_PUBLIC_KEY_BASE64
GAME_TICKET_ACTIVE_KID
PROTOCOL_VERSION=2

COGNITO_CLIENT_ID
COGNITO_CLIENT_SECRET
COGNITO_ISSUER
COGNITO_DOMAIN
COGNITO_REDIRECT_URI

ALLOWED_ORIGINS
SERVER_VERSION
LOG_LEVEL
```

실제 secret은 Git에 저장하지 않는다. `PROTOCOL_VERSION` 환경값과 코드 상수의 이중 원본을 만들지 말고 배포 검증용으로만 사용한다.

## 17. 0.2 통합 순서

완료된 기반은 v02 map의 GameCore world 적재, room-local 좌표, 기본 자동 공격/AI/피해, 자원·정적 리스폰, XP/draft, hidden drop/equip, waypoint와 기본 boss 승패, Schema 및 RoomGameScene의 기본 연결이다.

남은 순서:

1. 개인 drop state를 RoomGameScene과 equip UI에 연결하고 StateView privacy를 E2E 검증한다.
2. 스킬·회피, 플레이어 부활을 GameCore와 protocol event에 추가한다.
3. build 명령과 `structures` lifecycle, 비용·경로 검증을 연결한다.
4. boss 패턴과 기여 통계 payload를 완성하고 결과 transaction/overlay를 E2E 검증한다.
5. 모든 command의 phase·거리·대상 공개 범위 검증을 통일한다.
6. disconnect 만료, guest rate/cleanup, DB integration test를 보강한다.
7. 3-browser E2E, staging, backup/restore, load test를 수행한다.

## 18. 테스트 매트릭스

| 영역 | 현재 자동 검증 | 남은 필수 검증 |
|---|---|---|
| auth | 암호화·return path·JWT 만료 | 실제 Cognito, session/CSRF route |
| protocol | strict schema, v1 거부, v2 명령 | phase·거리·대상 공개 범위 |
| Schema | 발견 entity 적재, 개인 draft/drop StateView | client lifecycle, structures, private E2E |
| 기본 Core | ready, seq, phase | 부활·스킬·건설·boss pattern |
| v02 시뮬레이션 | map과 room/attack/AI/resource/respawn/travel/recall/boss | PartyRoom/Phaser E2E |
| 장비 | rarity·분포·개인 결정론, GameCore 소유권·장착 | protocol 중복 seq와 client UI |
| 성장 | 레벨30·draft 경로, server XP·선택 | client draft UI E2E |
| DB | 타입·repository 코드 | migration/rollback/concurrency integration |
| Room | ticket jti unit | solo/3-client/reconnect/dispose E2E |
| 배포 | 구성 파일 | staging rollback·restore·부하 |

## 19. 비범위

- 3명을 초과하는 파티, 2인 동적 보정, 관전자, 신규 중도 참가.
- Room 프로세스 장애 후 실시간 복원.
- Redis/RDS/ALB/다중 AZ.
- 실시간 tick의 PostgreSQL 저장.
- 영구 장비·랭킹·상점·결제.

이 비범위는 “현재 미구현”과 구분한다. 0.2 필수 기능인 전투·AI·웨이포인트·장비의 서버 권위화는 비범위가 아니다.
