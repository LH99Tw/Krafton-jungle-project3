# 《5일 뒤 마왕》 프로토콜·데이터 명세

> 공용 계약 버전은 v8이다. 실제 필드 검증의 단일 원본은 `packages/protocol/src/index.ts`, Colyseus 상태의 단일 원본은 `apps/game-server/src/state.ts`, DB의 단일 원본은 `packages/db/src/schema.ts`다.

## 1. 버전과 호환성

- `PROTOCOL_VERSION = 8`
- Room 입장, 명령, 입력 frame, world frame, 미니맵 메시지는 v8 literal을 요구한다.
- 공식 맵 revision이 서버와 다르면 게임 룸 입장을 거절한다.
- 구버전 payload를 자동 변환하지 않는다.
- 모든 명령 객체는 strict schema이며 정의되지 않은 필드를 거절한다.

## 2. Room 종류

| 티켓 범위 | Colyseus 룸 | 목적 |
|---|---|---|
| `global_chat` | `global_chat` | 전체 채팅 |
| `lobby` | `lobby_room` | 파티 대기실 |
| `party` | `party_room` | 실제 게임 |

게임 티켓은 기본 90초 유효한 RS256 JWT다. `iss=five-days-web`, `aud=five-days-game-server`이며 `sub`, `displayName`, `room`, `jti`를 포함한다. DB에서 jti를 한 번만 소비한다.

## 3. 게임 RoomOptions

| 필드 | 형식 |
|---|---|
| `heroClass` | `swordsman | archer | mage` |
| `sessionMode` | `prototype | full` |
| `difficulty` | `easy | normal | hard` |
| `partyMode` | `solo | coop` |
| `protocolVersion` | `8` |
| `mapRevision` | 1~96자 ID |

룸 생성 옵션과 참가 옵션의 파티 모드, 세션 모드, 난이도, 맵 revision이 같아야 한다.

## 4. 명령 envelope

신뢰 명령의 공통 필드:

```ts
{
  v: 8;
  type: string;
  seq: number;
  clientTime: number;
  payload: object;
}
```

`seq`는 연결 세션별 단조 증가한다. 입력 frame과 신뢰 명령은 서로 다른 sequence 공간을 사용한다.

## 5. 클라이언트 명령

| type | payload | 서버 처리 상태 |
|---|---|---|
| `room.ready` | `{ ready }` | 구현 |
| `player.input` | `{ x, y, aim, buttons }` | 구현, 호환 경로 |
| `input.frame` | `{ v, seq, clientTime, x, y, aim, buttons }` | 구현, 실시간 주 경로 |
| `skill.cast` | `{ skillId, targetX, targetY }` | 서버 처리 구현, 현재 웹에서 직접 호출하지 않음; Q/E는 자동 발동 |
| `player.interact` | `{ targetId }` | 구현 |
| `travel.request` | `{ waypointId, destinationId }` | 구현 |
| `recall.request` | `{}` | 구현 |
| `upgrade.choose` | `{ draftId, upgradeId }` | 구현 |
| `equipment.equip` | `{ dropId }` | 구현 |
| `equipment.inventory-equip` | `{ inventoryIndex }` | 구현 |
| `shop.buy` | `{ offerId }` | 구현 |
| `shop.reroll` | `{}` | 구현 |
| `shop.lock` | `{ offerId }` | 구현 |
| `shop.sell` | `{ inventoryIndex }` | 구현 |
| `shop.upgrade` | `{ inventoryIndex }` | 구현 |
| `shrine.claim` | `{}` | 구현 |
| `checkpoint.set` | `{}` | 구현 |
| `gamble.play` | `{}` | 구현 |
| `altar.reroll` | `{}` | 구현 |
| `gold.claim` | `{}` | 구현 |
| `build.place` | `{ buildingId, gridX, gridY }` | `BUILD_NOT_READY` |
| `build.upgrade` | `{ structureId }` | `BUILD_NOT_READY` |

입력 bitmask 계약:

| bit | 값 | 동작 |
|---|---:|---|
| 0 | 1 | Q |
| 1 | 2 | E |
| 2 | 4 | Dash |

현재 웹 전송 코드는 Space만 수집하면서 값 `1`을 보내므로 대시가 아닌 Q bit로 해석된다. Q/E는 별도 키 입력 없이 서버에서 자동 발동한다. Space 매핑은 수정 전까지 알려진 호환성 결함으로 취급한다.

## 6. 서버 이벤트

| 메시지 | 역할 |
|---|---|
| `world.frame` | server tick, input ack, AOI transform |
| `combat.action` | 기본 공격, 근접, 패턴 예고·해결 렌더 이벤트 |
| `result` | 최종 결과와 팀·개인 통계 |
| `protocol-error` | 거부 코드 |
| `message` | 사용자 안내 |
| `fastlane.offer` | WebTransport URL과 단기 토큰 |
| `minimap.init` | geometry와 전체 탐색 mask |
| `minimap.delta` | 탐색 mask 증분 |

`world.frame`은 플레이어 최대 3명, 적 최대 512개를 허용한다. transform은 `id`, `roomId`, 좌표, 속도, aim, 불연속 flag를 포함한다.

## 7. PartyRoom Schema

공용 상태:

- protocolVersion, matchId, seed
- phase, result, day, serverTime, elapsed, phaseEndsAt
- currentZone, base HP, gold, team level/XP
- players, rooms, doors, enemies, waypoints, specialRooms
- structures 컬렉션: 계약만 존재하며 현재 비어 있음

플레이어 상태:

- 식별자, 클래스, room/좌표/aim
- HP, level, teamPower, 생존·부활·접속·준비
- 계산된 공격·방어·치명타·공격속도·사거리·이동속도
- Q/E/Dash 쿨다운과 마지막 스킬 정보
- 피해, 보스 피해, 킬, 사망, 건설, 골드 소비, 게이트 파괴
- 장비 요약, 6칸 개인 인벤토리, 체크포인트와 특수 방 개인 진행 상태
- 개인 증강 draft

적 상태:

- 종류, 행동, room, 생성 room, target
- 좌표, HP, 생존
- 패턴 종류·페이즈·남은 시간·sequence

## 8. 개인 상태와 공개 범위

Colyseus `StateView`를 사용한다.

| 데이터 | 공개 대상 |
|---|---|
| 파티 플레이어 기본 상태 | 파티 전체 |
| 방·문·웨이포인트 | 발견·AOI 규칙에 따른 파티 |
| 적 | 클라이언트 AOI |
| 개인 증강 draft | 소유자 |
| 개인 드롭 | 소유자 |
| 개인 장비 | 파티 표시용 요약, 상세는 소유자 흐름 |
| 개인 인벤토리·상점 재고 | 소유자 |
| 발견한 특수 방 공용 상태 | 파티 전체; 개인 획득·시도 상태는 플레이어별 필드 |

다른 사용자의 drop ID로 장착을 요청하면 거절해야 한다.

## 9. REST API

| 경로 | 메서드 | 인증 | 역할 |
|---|---|---|---|
| `/api/session` | GET | 선택 | viewer와 CSRF 조회 |
| `/api/auth/login` | GET | 없음 | Cognito 로그인 시작 |
| `/api/auth/callback` | GET | OAuth state | 코드 교환·세션 생성 |
| `/api/auth/guest` | POST | Origin/rate limit | 게스트 생성 |
| `/api/auth/logout` | POST | CSRF/Origin | 세션 폐기 |
| `/api/game-ticket` | POST | CSRF/Origin | 룸 범위 티켓 발급 |
| `/api/runs` | GET | 사용자 | 본인 경기 기록 |
| `/api/guestbook` | GET/POST/PATCH/DELETE | 작업별 상이 | 방명록 |
| `/api/health/live` | GET | 없음 | 프로세스 생존 |
| `/api/health/ready` | GET | 없음 | DB 포함 준비 상태 |

게임 결과를 클라이언트가 생성하거나 수정하는 REST API는 없다.

## 10. PostgreSQL

| 테이블 | 핵심 용도 |
|---|---|
| `users` | Cognito/게스트 사용자 |
| `auth_sessions` | hash된 세션 토큰, 암호화 refresh token, 만료·폐기 |
| `game_ticket_nonces` | 티켓 jti와 1회 소비 |
| `guestbook_entries` | 공개 메모와 위치·편집 비밀번호 hash |
| `matches` | 룸, 모드, 난이도, seed, 버전, 최종 상태 |
| `match_players` | 클래스, 레벨, 파워, 전투·기여 통계 |

match 상태는 `running | victory | defeat | abandoned | server_error`다. 결과 확정은 match row를 `FOR UPDATE`로 잠근 뒤 `running`일 때만 한 번 수행한다.

실시간 좌표, 적, 방 탐색 mask, 입력 frame은 DB에 저장하지 않는다.

## 11. 변경 규칙

1. breaking 변경은 `PROTOCOL_VERSION`을 올린다.
2. protocol Zod schema, 서버 처리, 클라이언트 전송, 테스트, 이 문서를 한 PR에서 변경한다.
3. Schema 필드 삭제는 구 클라이언트 rollout을 고려해 배포 순서를 명시한다.
4. DB 변경은 Drizzle migration을 생성하고 순방향 배포와 롤백 영향을 기록한다.
5. 개인 데이터 추가 시 `StateView` 공개 범위를 먼저 정의한다.
