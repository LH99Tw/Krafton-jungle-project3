# 《5일 뒤 마왕》 웹 클라이언트

`apps/web`은 Next.js·React 로비/HUD, Phaser 렌더러, 인증·세션·REST BFF, Colyseus 클라이언트를 포함합니다. 0.2 목표는 솔로 1인 또는 실제 사용자 3인의 협동 게임이며 AI 파티원은 사용하지 않습니다.

## 실행

저장소 루트에서 Node.js 22.13 이상, pnpm 11, Docker를 사용합니다.

```bash
pnpm install
pnpm local:setup
pnpm local:up
pnpm db:migrate
pnpm dev
```

검증:

```bash
pnpm test
pnpm typecheck
pnpm build
```

## 실제 구현 범위

### 구현

- 검사·궁수·마법사 클래스 선택과 network mode에서 분리된 Phaser 로컬 수직 슬라이스
- 로컬 mode의 WASD 이동, 포인터 조준, 공격·스킬·회피, phase·적·보스·건설·성장 콘텐츠
- 서버 세션, Cognito Authorization Code + PKCE 경로, 비운영 개발 로그인
- 비운영 환경 또는 production 환경 flag로 여는 공개 guest session
- PostgreSQL 기반 사용자·세션·방명록·매치 저장소
- 90초 RS256 game-ticket과 Colyseus `party_room` 접속
- protocol v3 60Hz 입력, WebTransport 우선/WSS 폴백, 30Hz 좌표 보간, 채널별 seq와 재접속
- 실행 scene인 `RoomGameScene`의 network/local mode 분리
- network mode에서 로컬 session·이동·전투·AI·경제 tick을 실행하지 않는 snapshot-only 갱신
- server room/door, 같은 방 player/enemy, phase·base·gold·팀 성장·teamPower·실시간 통계의 장면·HUD 반영
- 개인 draft 선택, 장비 요약과 owner-only drop 표시·클릭 교체, waypoint·travel·recall, 종료 state/event의 UI 연결

### 부분 구현

- solo 1명/coop 3명 Room, ready, reconnect, room-local 이동·aim·phase
- 서버 3구역 map/door, 기본 자동 공격·정적/침공 AI, 자원 생산·정적 리스폰
- 팀 XP·개인 draft와 session별 command seq 거부
- hidden 개인 장비, waypoint 전원 5초 이동, 기본 boss 승패와 결과 transaction
- rooms·doors·enemies·waypoints·drops와 player 장비/draft Schema 동기화
- `StateView`를 통한 개인 draft/drop 공개 제한
- private drop은 transport와 현재 room sprite에 연결되고 클릭 시 서버에 교체 장착을 요청함; 비교·확인·분해 UI는 남음
- 기본 boss는 서버 state로 렌더링되지만 공격 패턴은 없음
- network HUD는 `buildSupported=false`로 건설 미지원을 명시하고 로컬 건설 판정을 실행하지 않음
- 종료 state의 승패·사유와 최종 팀 집계 snapshot이 overlay를 복구함; 개인별 기여 상세 payload는 미완료

### 남은 서버 통합

- 장비 비교·확인·분해, 특수 옵션과 폐기 lifecycle UI
- 스킬·회피·플레이어 부활·건설·보스 공격 패턴의 서버 판정
- 모든 명령의 phase·거리·대상 공개 범위 검증
- 개인별 서버 기여 통계와 매치 결과 상세 표시의 end-to-end 연결
- 실제 세 브라우저 협동 E2E와 운영 환경 검증

network mode는 서버 snapshot을 simulation 원본으로 사용합니다. 다만 스킬·회피·플레이어 부활·건설·보스 공격 패턴, 장비 비교·분해와 실제 세 브라우저 검증이 남아 있으므로 게임 전체의 서버 권위 멀티플레이가 완성된 상태는 아닙니다.

로컬 수직 슬라이스와 서버 통합 경계는 [ARCHITECTURE.md](./ARCHITECTURE.md), 전체 백엔드 현황은 [백엔드 아키텍처](../../Document/backend_node_colyseus_postgresql.md), 게임 규칙은 [0.2 명세서](../../Document/0.2버전_명세서.md)를 참고하세요.
