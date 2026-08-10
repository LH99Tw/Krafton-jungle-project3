# 《5일 뒤 마왕》 0.2 기술·게임플레이 아키텍처

> 상태: 기술 선택 확정, 서버 권위 게임 규칙 통합 진행 중
> 기준일: 2026-08-10
> 상세 백엔드 현황: `backend_node_colyseus_postgresql.md`

## 1. 확정 기술 선택

이 프로젝트는 후보 비교 단계를 지나 다음 스택으로 구현되고 있다.

| 영역 | 확정 기술 | 책임 |
|---|---|---|
| 웹 UI/BFF | Next.js Node + React | 로비·HUD·OAuth·REST |
| 2D 렌더링 | Phaser 3 | 입력·카메라·스프라이트·이펙트 |
| 실시간 서버 | Node.js + Colyseus | Room·상태 patch·서버 시뮬레이션 |
| 게임 규칙 | TypeScript `packages/game-core` | Phaser 비의존 결정론적 규칙 |
| 네트워크 계약 | Zod `packages/protocol` v2 | client/server 명령 검증 |
| 영속 저장 | PostgreSQL + Drizzle ORM | 사용자·세션·방명록·매치 결과 |
| 인증 | Cognito/Google 또는 공개 guest session | 서버 세션과 game-ticket 발급 |
| 배포 | Docker Compose + Caddy + Lightsail | HTTPS/WSS·프로세스 분리 |

기술 대안 비교가 다시 필요해질 때는 현재 아키텍처 문서에 후보를 섞지 않고 별도 의사결정 문서에서 다룬다.

## 2. 제품 구조

```text
             ┌──────────────────────────────┐
             │ Browser                     │
             │ React UI + Phaser renderer  │
             └──────────┬───────────┬───────┘
                        │ HTTPS     │ WSS
                        ▼           ▼
             ┌──────────────┐  ┌────────────────┐
             │ Next.js Node │  │ Colyseus Room  │
             │ Auth / REST  │  │ GameCore 20Hz  │
             └──────┬───────┘  └────────┬───────┘
                    │                   │
                    └─────────┬─────────┘
                              ▼
                         PostgreSQL
```

핵심 원칙:

- 브라우저는 입력과 표현을 담당한다.
- 목표 권위 경계에서는 Colyseus가 시간·좌표 유효성·전투·AI·경제·성장·이동·승패를 확정한다.
- game-core는 브라우저나 DB 없이 테스트할 수 있어야 한다.
- PostgreSQL은 매 tick 상태가 아니라 계정·세션·런 결과를 저장한다.

## 3. 실제 구현과 목표 구분

### 3.1 구현 또는 서버 연결

- Next.js Node, PostgreSQL/Drizzle, Cognito/guest session route, game-ticket. Cognito 실계정 운영 검증은 별도다.
- Colyseus party_room, solo1/coop3 옵션, ready, reconnect, 이동, aim, phase.
- protocol v2 strict schema와 확장 PartyRoom Schema.
- GameCore의 결정론적 3구역 world, room-local 이동과 door 전환.
- 서버 자동 공격, 정적/히든 반격 AI, 일반 정적 리스폰, 밤 침공 경로와 base 피해.
- 발견 자원 방의 +1골드/5초 생산.
- 팀 XP·개인 draft, hidden 개인 장비, waypoint 전원 5초 이동, 기본 boss 승패.
- PartyRoom의 rooms/doors/enemies/waypoints/drops와 player 장비/draft 동기화.
- 실행 scene인 `RoomGameScene`의 network/local mode 분리.
- network mode의 snapshot-only 갱신과 server room/door/player/enemy 렌더링.
- 개인 draft 선택·장비 요약·owner drop 표시/클릭 equip, teamPower·실시간 팀 통계, waypoint/travel/recall, 서버20초/client18초 재접속과 terminal 결과 overlay 연결.
- v02 property test와 GameCore integration test.
- Docker/Caddy/Lightsail 배포 기반.

### 3.2 부분 구현

- 개인 drop transport·sprite·클릭 교체는 연결됐지만 장비 비교·확인·분해와 특수 옵션 UI는 없다.
- upgrade/interact/travel/recall/equip은 서버 의미 처리가 있고, skill/build는 준비 전 오류를 반환한다.
- network HUD는 건설 미지원 상태를 명시하며 로컬 건설을 대체 판정으로 실행하지 않는다.
- 서버 기본 승패·팀 기여 집계와 결과 transaction은 종료 화면에 연결됐으나 개인별 최종 상세 payload와 3-client E2E는 남았다.
- room 이동 예측·보간과 전투 이펙트의 서버 event 표현은 prototype 수준이다.

### 3.3 목표

- 장비 비교·확인·분해 lifecycle과 공격·피해 event 표현의 완성.
- 스킬·회피, 플레이어 부활, 건설의 서버 권위 처리와 client 표현.
- 보스 공격 패턴과 3인 판정.
- 세 브라우저 E2E, 공개 배포, 운영 관측.

## 4. 0.2 게임 루프

### 4.1 파티

- `solo`: 실제 사용자 1명.
- `coop`: 실제 사용자 정확히 3명이며 서버 시작 요구도 3명으로 고정돼 있다.
- AI 동료 없음.
- 협동 이동 정족수는 `connected && alive` 사용자다.

### 4.2 시간

| 모드 | 낮 | 밤 | 정비 |
|---|---:|---:|---:|
| prototype | 60초 | 25초 | 5초 |
| full | 210초 | 75초 | 15초 |

위 표를 phase 시간의 단일 기준으로 사용한다.

### 4.3 진행

```text
낮: 룸 탐색·정적 몬스터·자원·히든 장비
  ↓
밤: 게이트발 동적 몬스터와 베이스 방어·건설
  ↓
정비: 성장 선택·시설 보강
  ↓
구역 게이트와 웨이포인트
  ↓
구역3 끝 웨이포인트 5초 점유
  ↓
격리된 최종 보스 아레나
```

## 5. 룸맵 설계

- 구역 3개, 각 5×5 논리 그리드.
- 각 구역은 정확히 연결된 15개 방.
- 시작 `(0,4)`, 게이트 `(4,0)`.
- 자원4, 정적4, 빈2, 중앙 웨이포인트1, 히든2, 시작1, 게이트1.
- 히든은 graph 거리 합 기준 최심부 2개이며 통로 1개.
- 서버는 모든 방·door 상태를 생성하고 Schema로 전송한다.
- network mode는 서버의 발견 room/door를 미니맵에, 현재 room과 door·같은 방 player/enemy를 `RoomRenderer` 장면에 표시한다.
- 분산 탐색 시 각 클라이언트가 자기 방을 주로 렌더링하는 기본 경계는 연결됐으며, room 전환 보간과 실제 3-client 검증은 남아 있다.

## 6. 전투와 AI

### 6.1 자동 공격

- 커서 방향 원거리·마법 60°, 근접 110° 원뿔.
- 같은 방·사거리·원뿔 안에서 가장 가까운 적.
- 동거리면 안정적인 network ID로 결정.
- GameCore가 공격 주기·피해·처치·XP를 계산한다.

이 기본 자동 공격은 PartyRoom에 연결됐다. network mode의 Phaser는 로컬 공격을 계산하지 않고 같은 방의 서버 enemy/HP/alive를 렌더링한다. 공격·피해 이펙트와 스킬 판정은 별도 보강 대상이다.

### 6.2 적

- 구현: 정적/히든 적은 피격 후 반격하고 생성 방 밖으로 나가지 않는다.
- 구현: 밤 침공 적은 구역 게이트에서 zone1 base까지 논리 room path를 2.5초 단위로 이동하며 플레이어 어그로를 쓰지 않는다.
- 구현: 히든 적 처치 시 사용자별 개인 장비를 결정론적으로 지급한다.
- 구현: 일반 정적 적은 prototype 30초/full 90초 후 원래 spawn에서 리스폰하며 히든·게이트는 리스폰하지 않는다.
- 남음: 히든 원거리 투사체와 더 정밀한 침공 이동 표현.

## 7. 성장·경제·타이쿤

- 구현: 팀 XP·팀 레벨 공유, 사용자별 결정론적 3-choice 증강과 서버 선택 검증.
- 구현: 레벨 상한30, 전직10/20/30, 공격 전용 일반 증강10종·37 stack, 클래스별 전직5종.
- 구현: 히든 개인 드롭 Legendary80% / Mythic20%, 소유권 검증과 장착 보너스.
- 구현: 무기=공격, 방어구=HP+방어, 장신구=공격속도의 임시 prototype 수치.
- 구현: 발견한 자원 방마다 팀 골드 +1/5초.
- 남음: 건설 배치·강화와 서버 비용·좌표·경로 재검증.

현재 GameCore 클래스/장비 수치는 작동 확인용 기본값이다. 밸런스 테이블 승인 후 서버 원본 데이터로 교체해야 한다.

## 8. 보스 아레나와 내러티브

격리 아레나 선택은 유지한다. 진입 조건은 날짜 도달이나 로컬 버튼이 아니라 구역3 게이트 파괴와 실제 사용자 전원의 웨이포인트 5초 점유다.

보스 패턴 후보:

1. 방사/나선형 탄막: 이동 경로 읽기.
2. 플레이어 위치 예고 장판: 분산과 회피.
3. 졸개 소환: 단일 딜과 처리 우선순위 충돌.
4. HP 30% 광폭화: 패턴 간격 단축.

GameCore에는 구역3 gate waypoint의 전원 5초 점유, 격리 boss room 이동, 기본 boss HP와 처치 승리가 구현됐다. network mode는 이 서버 boss entity를 일반 enemy 경로로 표시하지만 boss의 공격·탄막·장판·소환·광폭화는 없다. 로컬 mode의 보스 패턴은 network mode 판정으로 사용하지 않는다.

## 9. 네트워크 모델

### 9.1 입력

- client는 이동축, aim, button, 명시적인 상호작용 의도만 전송한다.
- HP·피해·골드·XP·드롭·승패는 전송하지 않는다.
- protocol v2 strict Zod, 4KiB, 초당30개 제한.
- 모든 명령은 client session별 단조 증가 seq를 통과해야 한다.
- 명령별 phase·거리·대상 공개 범위 검증을 일관되게 강화하는 작업은 남아 있다.

### 9.2 상태

- Player와 발견된 Room, Door, Enemy, Waypoint는 GameCore 값으로 Colyseus Schema에 동기화한다.
- UpgradeDraft와 Drop은 `StateView`로 소유 사용자에게만 전달한다.
- Structure Schema는 정의돼 있지만 건설 미구현으로 비어 있다.
- 클라이언트 transport는 player/room/door/enemy/waypoint, 개인 draft·장비 요약·teamPower·실시간 팀 통계를 view model로 변환한다. private drop map은 아직 변환하지 않는다.
- 고빈도 투사체는 필요한 경우 seed/pattern event와 서버 피격 판정을 조합한다.
- 현재 network mode는 서버 위치를 그대로 소비한다. 이동 예측·보간은 후속 최적화다.

## 10. 저장과 인증

- PostgreSQL: users, auth_sessions, guestbook_entries, matches, match_players.
- 결과는 game-server만 transaction으로 기록한다.
- Cognito/Google, 개발 bypass, 공개 guest session 경로가 있다. Cognito 실계정 운영 검증은 남아 있다.
- 공개 guest는 비운영 환경에서 허용되고 production에서는 `PUBLIC_PLAYTEST_ENABLED=true`일 때만 허용된다. rate limit·만료 row 정리는 보강 대상이다.
- 영구 장비·랭킹·메타 상점은 0.2 비범위다.

## 11. 0.2 남은 구현 단계

### 단계 A — 남은 클라이언트 연결

- 장비 비교·확인·분해, 특수 옵션과 폐기 UI를 완성한다.
- 서버 공격·피해·스킬 event를 장면 이펙트와 HUD에 연결한다.
- 서버 개인별 최종 결과·기여 상세를 종료 화면에 표시한다.

### 단계 B — 남은 서버 규칙

- 스킬·회피, 플레이어 부활.
- build validator와 structure lifecycle.
- boss 공격 패턴과 모든 명령의 phase·거리·대상 공개 범위 검증.

### 단계 C — 통합 검증

- 서버 개인별 기여·결과 상세 표시를 브라우저 런과 E2E 연결한다.
- 3-client와 solo/full/prototype, disconnect/reconnect를 자동 검증한다.

### 단계 D — 운영

- 공개 인증 정책과 악용 제한.
- staging migration, health rollback, DB backup/restore.
- 동시 사용자20명 부하와 30분 메모리/tick 관측.

## 12. 기술 Definition of Done

- [구현] network mode에서 Phaser는 session·이동·전투·AI·경제의 최종 값을 계산하지 않는다.
- 세 클라이언트가 같은 seed·room·entity·HP·gold를 본다.
- 잘못된 command, 중복 seq, 다른 사용자 drop, 불법 이동·건설이 거부된다.
- solo1/coop3의 시작·재접속·종료가 자동 테스트된다.
- 서버 결과만 DB에 한 번 저장된다.
- staging에서 공개 링크로 한 런을 완주하고 rollback·복구 절차를 재현한다.
