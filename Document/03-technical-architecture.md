# 《5일 뒤 마왕》 기술 아키텍처

> 현재 빌드의 실행 구조와 책임 경계를 설명한다. 목표 아키텍처는 별도 사실처럼 기록하지 않고 마지막 제한 섹션에만 둔다.

## 1. 시스템 구성

```text
Browser
├─ HTTPS → Next.js Node
│  ├─ React 접근·로비·HUD
│  ├─ 인증 세션·CSRF·게임 티켓 BFF
│  └─ Drizzle → PostgreSQL
└─ WSS / WebTransport → Colyseus
   ├─ global_chat
   ├─ lobby_room
   └─ party_room → GameCore
```

| 모듈 | 책임 |
|---|---|
| `apps/web` | Next.js UI/BFF, React 상태, Phaser 렌더링, Colyseus 클라이언트 |
| `apps/game-server` | 인증된 실시간 연결, 룸 생명주기, 상태 공개 범위, 결과 저장 |
| `packages/game-core` | 프레임워크 독립 게임 규칙과 결정론적 시뮬레이션 |
| `packages/protocol` | Zod 메시지 계약과 공용 타입 |
| `packages/auth` | 세션 암호화, OAuth 보조 함수, RS256 게임 티켓 |
| `packages/db` | PostgreSQL 연결, Drizzle Schema·repository·migration |

## 2. 웹 런타임

`app/page.tsx`가 서버에서 세션과 CSRF를 확인하고 `GameShell`에 viewer를 전달한다. `GameShell`은 접근, 로비, 선택, 플레이, 결과 화면을 관리한다.

Phaser는 클라이언트 전용으로 지연 로드한다. `GameBridge`가 React 명령과 Phaser 이벤트를 연결하며, `RoomGameScene` 하나가 현재 실행 Scene이다.

실행 모드:

- 네트워크: 서버 snapshot과 world frame만 게임 상태 원본으로 사용한다.
- 로컬 수직 슬라이스: 브라우저 내부 규칙으로 시연한다.
- 에디터 코어: 로컬 `GameCore`를 고정 틱으로 실행해 편집 맵을 검증한다.

현재 `RoomGameScene`에는 세 모드의 렌더링·입력·로컬 규칙이 함께 있어 변경 영향도가 크다.

## 3. 게임 서버 런타임

게임 서버는 Express HTTP 서버 위에 Colyseus WebSocket transport를 구성한다.

| 룸 | 역할 |
|---|---|
| `global_chat` | 전체 채팅과 제한된 최근 기록 |
| `lobby_room` | 방장, 준비, 클래스 선택, AI 슬롯, 게임 룸 생성 |
| `party_room` | 권위 시뮬레이션과 개인 상태 공개 |

`party_room` 생성 시 공식 맵 revision과 옵션을 검증하고 PostgreSQL에 `running` match를 만든다. 게임이 종료되면 개인 통계를 포함해 멱등 트랜잭션으로 확정한다.

## 4. 실시간 시뮬레이션과 전송

| 채널 | 주기 | 내용 |
|---|---:|---|
| GameCore | 60Hz | 이동, 충돌, 전투, AI, 페이즈, 경제 |
| World frame | 30Hz | AOI 내 플레이어·적 transform, 입력 ack |
| Colyseus Schema | 10Hz | 페이즈, HP, 방, 적, 장비·인벤토리, 특수 방, draft 등 |
| Keyframe | 500ms | 불연속·손실 복구용 상태 |
| 적 전체 keyframe | 5초 | 적 delta 누락 복구 |

서버는 한 번에 최대 4개의 catch-up tick만 수행한다. 더 큰 지연은 이동·AI를 재생하지 않고 전투 쿨다운을 제한적으로 보정한다.

입력은 WebTransport datagram 경로를 우선하고 사용할 수 없으면 WSS를 사용한다. WebTransport 인증은 짧은 수명의 서명 토큰과 1회 nonce를 사용한다.

## 5. 예측·보간·AOI

- 로컬 플레이어는 아직 ack되지 않은 60Hz 입력을 서버 좌표에 재적용한다.
- 작은 오차는 부드럽게 보정하고 96px 초과 또는 순간이동 flag는 즉시 맞춘다.
- 원격 플레이어와 적은 snapshot 사이를 보간하고 제한적으로 외삽한다.
- 적 transform은 현재 방과 그래프상 인접 AOI만 전송한다.
- 룸 이동 같은 연속 변환과 실제 순간이동을 flag로 구분한다.

미니맵 geometry와 방 단위 탐색 마스크는 서버가 제공한다. 발견된 방은 전체 영역을 개척하며 클라이언트는 마커와 파티 위치를 렌더링한다. delta revision이 누락되면 전체 상태 resync를 요청한다. 실제 게임 화면의 캐릭터 시야와 야간 안개는 별도 클라이언트 렌더 계층이다.

## 6. 게임 코어 설계

`GameCore`는 Phaser, React, Colyseus, DB를 import하지 않는다. 입력과 `deltaSeconds`를 받아 상태를 갱신하고 snapshot·notice·combat event를 배출한다.

서브시스템:

- `AiPlayersDirector`: 수비·추종 AI와 경로 복구
- `InvaderDirector`: 웨이브, LOD, 경로 재계획, 부하 제한
- `TravelDirector`: 요청 플레이어의 웨이포인트 반경 검증, 3초 이동 준비와 목적지 이동
- `world-build`: 공식 맵을 런타임 엔티티로 변환하고 seed별 게이트 후보 선택
- 특수 방 규칙: 상점·신전·함정·체크포인트·도박·제단·골드 상태와 상호작용

동일 seed와 동일 명령 순서는 맵 파생 결과, 드롭, 증강 draft에 대해 동일한 결과를 내야 한다.

## 7. 인증·보안 경계

- 운영 인증: Cognito Authorization Code + PKCE, Google IdP
- 개발 인증: 비운영 환경의 `DEV_AUTH_BYPASS`
- 공개 게스트: 비운영 또는 명시적 `PUBLIC_PLAYTEST_ENABLED`
- 웹 세션: HttpOnly cookie와 DB token hash
- mutation: CSRF cookie/header와 Origin 검증
- 게임 연결: 기본 90초 RS256 JWT와 DB nonce 1회 소비
- 메시지: Zod strict parse, 최대 4,096바이트, seq와 rate limit
- 공개 문자열: NFKC 정규화, 길이 제한, 제어문자와 `<`, `>` 차단
- 운영 시작: HTTPS/WSS, 키 길이, Origin, DB, 프로토콜 버전을 fail-closed 검증

## 8. 저장 경계

PostgreSQL은 사용자, 세션, 게임 티켓 nonce, 방명록, match와 최종 개인 결과를 저장한다. 실시간 entity나 매 틱 좌표는 저장하지 않는다.

클라이언트가 경기 결과를 POST하는 경로는 없다. `/api/runs`는 본인 기록 읽기 전용이다.

## 9. 테스트와 품질 게이트

현재 검증 명령:

```bash
pnpm map:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

2026-08-12 기준 자동 테스트 255개가 통과한다. 코어 테스트는 결정론, 충돌, 시야, AI 경로, 특수 방, 256 침략자 부하를 포함한다. 서버 테스트는 프로토콜, AOI, 재접속, 결과 저장, scheduler rollout을 포함한다.

부족한 범위:

- `packages/protocol`과 `packages/db`의 독립 테스트가 없음
- 실제 PostgreSQL을 사용하는 repository integration test 부족
- 실제 브라우저 3개 기반 전체 E2E 부족
- 브라우저 키 입력에서 서버 bitmask까지의 통합 테스트 부족

## 10. 현재 기술 부채

1. 온라인 Space 입력이 대시 bit `4`가 아닌 Q bit `1`로 전송된다.
2. 프로덕션 네트워크 실패가 로컬 런으로 폴백할 수 있다.
3. `RoomGameScene`, `GameCore`, `PartyRoom`, `ColyseusTransport`에 복잡도가 집중돼 있다.
4. 건설 Schema는 있지만 서버 lifecycle이 없다.
5. 다중 서버 확장을 위한 Redis presence/driver와 공유 rate limit은 없다.

우선 분리 대상은 입력 컨트롤러, 네트워크 월드 어댑터, 로컬 런타임, 렌더 효과, snapshot 변환이다.
