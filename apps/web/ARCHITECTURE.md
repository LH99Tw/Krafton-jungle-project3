# 0.2 웹 클라이언트·게임 서버 연결 구조

> 이 문서는 `apps/web`의 현재 구조를 설명합니다.
> 전체 백엔드 상태는 [`Document/backend_node_colyseus_postgresql.md`](../../Document/backend_node_colyseus_postgresql.md), 0.2 게임 규칙은 [`Document/0.2버전_명세서.md`](../../Document/0.2버전_명세서.md)를 참고하세요.

## 1. 현재 실행 구조

```text
Browser
├─ HTTPS/REST → Next.js Node → packages/db → PostgreSQL
│                ├─ React lobby/HUD
│                ├─ OAuth·guest·server session
│                └─ guestbook·runs·game-ticket
│
└─ WSS → Colyseus party_room → GameCore
           ├─ 현재: room·전투/AI·자원/성장·respawn·travel
           ├─ 동기화: players·발견 entity·개인 draft/drop
           └─ 남음: skill·player revive·build·boss pattern
```

Phaser는 브라우저 렌더러입니다. 현재 실행 scene인 `RoomGameScene`은 network mode에서 로컬 session·이동·전투·AI·경제 tick을 실행하지 않고 server snapshot만 소비합니다. 로컬 수직 슬라이스 simulation은 network mode와 분리돼 있습니다. 다만 서버 스킬·건설·보스 패턴과 전체 E2E가 남아 있어 3인 게임 전체 완료로 표현하지 않습니다.

## 2. 저장소 경계

```text
apps/web/
├─ app/
│  ├─ api/auth/               Cognito·guest·logout
│  ├─ api/session/            현재 viewer
│  ├─ api/game-ticket/        90초 Colyseus JWT
│  ├─ api/guestbook/          공개 조회·인증 작성
│  ├─ api/runs/               본인 전적 읽기, client POST 거부
│  └─ auth/session.ts         DB session·CSRF·Origin
└─ src/
   ├─ features/game/          lobby·HUD·draft·result·minimap
   └─ game/
      ├─ client/              Phaser canvas와 texture
      ├─ content/             레거시 표시/로컬 수직 슬라이스 데이터
      ├─ domain/              React·Phaser view model
      ├─ runtime/             실행 RoomGameScene·RoomRenderer·bridge
      ├─ systems/             로컬 fallback progression/session
      └─ transport/           Colyseus 접속·입력·state 변환

apps/game-server/             Colyseus 권위 경계
packages/game-core/           Phaser 비의존 규칙
packages/protocol/            Zod protocol v5
packages/db/                  PostgreSQL Drizzle
packages/auth/                암호·OAuth 보조·game-ticket
```

`createGame.ts`는 `RoomGameScene`만 scene 목록에 등록합니다. `content`의 UI 표시값과 로컬 mode 수치는 서버 원본이 아니며, network mode의 원본은 GameCore/Colyseus state입니다.

## 3. 인증과 접속

### 3.1 사용자 세션

- 운영 후보: Cognito Authorization Code + PKCE + Google.
- 개발: `DEV_AUTH_BYPASS=true`인 비운영 환경에서 개발 사용자 세션.
- 공개 테스트: 비운영 환경 또는 `PUBLIC_PLAYTEST_ENABLED=true`이면 `/api/auth/guest`로 1일 guest session.
- 세션은 PostgreSQL hash token과 HttpOnly cookie를 사용합니다.
- mutation은 CSRF cookie/header와 Origin을 검증합니다.

### 3.2 게임 접속

1. React lobby가 `partyMode`, 클래스, 세션, 난이도를 선택합니다.
2. 인증 사용자가 `/api/game-ticket`에서 90초 RS256 JWT를 받습니다.
3. `ColyseusTransport`가 protocol v5 옵션으로 `party_room`에 `joinOrCreate`합니다.
4. solo는 1명, coop은 실제 사용자 3명이 준비돼야 시작합니다.
5. transport가 50ms 간격으로 이동축·aim·button bitmask를 보냅니다.
6. Colyseus state를 `NetworkWorldSnapshot`으로 변환해 React와 Phaser에 전달합니다.

## 4. 현재 데이터 흐름

```text
keyboard/pointer
      ↓
ColyseusTransport ── command ───────> PartyRoom → GameCore
      ↑                                      │
      └──── Colyseus Schema patch ───────────┘
      │
      ├─> GameShell → lobby·party·draft·result
      └─> GameBridge → RoomGameScene → room/player/enemy renderer + HUD snapshot
```

현재 동기화되는 핵심 값:

- player 기본 정보, room/좌표, HP, level, connected/ready.
- root phase/day/time, base HP, gold, team XP.
- server에서 발견된 rooms/doors/enemies/waypoints와 player 장비 Schema.
- `StateView`로 소유 사용자에게만 전달되는 draft/drop.
- transport의 players/rooms/enemies/waypoints, 개인 draft/equipment/drop, teamPower·실시간 팀 통계와 terminal result view model.
- RoomGameScene의 현재 room/door, 같은 방 player/enemy/owner drop 표현과 server-only network tick. drop 클릭은 서버 equip 명령을 보내며, network HUD는 `buildSupported=false`로 서버 건설 미지원을 명시합니다.

현재 클라이언트 또는 서버에 남은 값:

- 개인 drop의 비교·확인·분해와 특수 옵션 lifecycle UI.
- structures는 서버 건설 미구현으로 비어 있습니다.
- skill, 플레이어 부활, 건설, boss 공격 패턴은 서버에도 남은 작업입니다.
- server attack/피격 이펙트와 개인별 최종 기여 통계의 별도 event/result payload.
- room 이동 예측·보간과 세 브라우저 E2E.

따라서 HUD의 네트워크 연결 표시는 transport 연결을 의미하며 게임 전체 권위화 완료를 의미하지 않습니다.

## 5. protocol v5 사용

protocol v5가 정의하는 명령, 실시간 프레임, 벽 차폐형 파티 공유 탐색 마스크:

- `room.ready`
- `player.input`
- `skill.cast`
- `player.interact`
- `travel.request`
- `recall.request`
- `upgrade.choose`
- `equipment.equip`
- `build.place`
- `build.upgrade`

서버는 ready/input 외에 upgrade 선택, drop/waypoint/door 상호작용, travel, recall, equipment 장착을 GameCore에 연결했습니다. skill은 `SKILL_NOT_READY`, build는 `BUILD_NOT_READY`를 반환합니다.

`ColyseusTransport`는 interact, travel, recall, equip, upgrade API를 노출합니다. 개인 server draft는 `StateView`→transport→RoomGameScene→UpgradeDraft UI로 전달되고 선택은 `upgrade.choose`로 돌아갑니다. 활성 waypoint ID와 destination도 HUD command에 사용합니다. equip API는 있지만 개인 drop 자체의 client view가 아직 없습니다. skill/build는 서버가 준비 전 오류를 반환하며 `player.input.buttons`의 Q/E/Space도 GameCore가 아직 소비하지 않습니다. 모든 command는 session별 단조 증가 seq를 확인하고, phase·거리·대상 공개 범위 검증은 보강 대상입니다.

## 6. 로컬 모드와 network mode

| 항목 | 로컬 모드 | network mode 현재 | network mode 목표 |
|---|---|---|---|
| 이동 | Phaser | server 좌표·room 적용 | server+선택적 예측/보정 |
| phase | local simulation 없음 | server phase 적용 | server only |
| 파티 | 단일 사용자 | server players 렌더링 | server players |
| 맵 | local 5×5 room graph | server 발견 room/door를 RoomRenderer와 미니맵에 적용 | 보간·3-client 검증 |
| 적·전투 | Phaser local | server enemy/HP/alive만 소비, 로컬 tick 없음 | server skill/pattern+표현 event |
| XP·드롭·건설 | Phaser local | server XP/draft/equipment/drop 표시·클릭 equip; 비교 UI·build 없음 | server only 전체 lifecycle |
| 승패·통계 | Phaser local | server terminal state/event, 최종 팀 집계 overlay와 DB transaction | 개인별 최종 통계 payload |

네트워크 서버 URL이 없을 때의 fallback은 로컬 수직 슬라이스와 테스트 대체 경계일 뿐 주 실행 아키텍처가 아닙니다.

## 7. 목표 의존 방향

```text
packages/protocol ← packages/game-core ← apps/game-server → packages/db
        ↑                                      ↑
ColyseusTransport ─────────────────────────────┘
        ↓
React view model + Phaser renderer
```

- Phaser/React는 PostgreSQL에 접근하지 않습니다.
- Phaser는 game-core를 직접 호출해 최종 피해를 계산하지 않습니다.
- client가 match 결과를 POST하지 않습니다.
- 고빈도 entity는 Room 메모리와 Schema patch/event로 전달합니다.

## 8. 서버 권위 이전 순서

완료된 기반은 v02 map/door와 room-local 좌표, 기본 자동 공격/AI/피해, 자원/정적 리스폰, XP/draft, hidden 장비, waypoint, 기본 boss 승패, Schema와 RoomGameScene의 room/player/enemy/draft/equipment/drop 연결입니다. terminal result state도 overlay 복구 경로에 연결됐고 network mode의 로컬 simulation tick은 중단돼 있습니다.

남은 이전 순서:

1. 장비 비교·확인·분해와 특수 옵션 lifecycle UI를 구현합니다.
2. server skill·player revive·build·boss pattern을 구현하고 표현 event를 정의합니다.
3. command phase·거리·대상 공개 범위 검증과 client 오류 처리를 통일합니다.
4. server 개인별 최종 stats payload를 result overlay에 연결합니다.
5. 3-client room/travel/reconnect/result와 StateView privacy를 E2E 검증합니다.

로컬 mode는 기능 시연용으로 유지하되 network mode에 fallback 판정으로 섞지 않습니다.

## 9. 운영 경계

- Caddy만 80/443을 외부에 공개합니다.
- web/game-server/PostgreSQL은 내부 네트워크를 사용합니다.
- 실시간 entity tick을 PostgreSQL에 쓰지 않습니다.
- migration은 생성 SQL과 `drizzle-kit migrate`를 사용합니다.
- Redis/RDS/다중 Colyseus는 단일 Lightsail MVP 이후의 확장 항목입니다.

## 10. 완료 기준

- network mode에서 로컬 전투·AI·경제 판정이 실행되지 않습니다.
- 세 브라우저가 같은 map/entity/HP/gold/waypoint 상태를 봅니다.
- 모든 protocol 명령이 seq·phase·거리·소유권 검증을 통과해야 적용됩니다.
- 위치 예측 외의 클라이언트 변조가 게임 상태를 바꾸지 못합니다.
- 서버 승패와 기여 통계만 PostgreSQL에 저장됩니다.
