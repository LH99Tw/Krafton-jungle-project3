# Krafton Jungle Project 3 — 《5일 뒤 마왕》

로그라이트·디펜스·RPG·타이쿤을 결합한 데스크톱 웹 게임 프로젝트입니다. 0.2의 목표 플레이 모드는 솔로 1인과 실제 사용자 3인 협동입니다.

## 현재 상태

저장소의 실행 기반은 Next.js Node, Colyseus, PostgreSQL/Drizzle, Phaser 3, protocol v4로 전환되었습니다. 실시간 이동은 WebTransport 우선/WSS 폴백으로 동작하며 판정은 서버 권위를 유지합니다.

| 영역 | 상태 | 현재 범위 |
|---|---|---|
| 웹·인증·DB 기반 | 구현 | Next.js Node, 서버 세션, Cognito 경로, 개발 로그인, 선택적 공개 guest, PostgreSQL repository |
| 실시간 Room 기반 | 부분 구현 | solo 1명/coop 3명, ready, reconnect, room 이동·aim·phase 동기화 |
| protocol v4·하이브리드 동기화 | 구현 | 신뢰성 Schema와 60Hz 입력·30Hz AOI 좌표 프레임·파티 공유 탐색 마스크 |
| 0.2 서버 규칙 | 부분 구현 | 3구역 맵, 기본 전투/AI, 자원/리스폰, XP/draft, 장비, waypoint, 기본 boss 승패 |
| 클라이언트 서버 연결 | 부분 구현 | `RoomGameScene`이 network mode에서 서버 snapshot만 소비하며 room/player/enemy, 개인 draft·장비·drop, waypoint·재접속·종료 결과를 실제 장면과 UI에 연결 |
| 남은 게임 규칙·통합 | 목표 | 장비 비교·확인·분해 UI, 스킬·플레이어 부활·건설·보스 공격 패턴, 개인별 결과 상세와 3-client E2E 필요 |

브라우저에는 network mode와 별도의 로컬 수직 슬라이스도 남아 있습니다. network mode의 simulation 원본은 서버이며, 위 미완료 항목 때문에 현재 상태를 완성된 3인 멀티플레이로 보지는 않습니다. 0.2 완료 기준은 [`Document/backend_node_colyseus_postgresql.md`](./Document/backend_node_colyseus_postgresql.md)와 [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md)에 정리되어 있습니다.

## 로컬 실행

Node.js 22.13 이상, pnpm 11, Docker가 필요합니다.

```bash
pnpm install
pnpm local:setup
pnpm local:up
pnpm db:migrate
pnpm dev
```

- Web: `http://localhost:3000`
- Colyseus: `ws://localhost:2567`
- PostgreSQL: host `localhost:55432`

`local:setup`이 만드는 `.env.local`은 비운영 개발 로그인 경로를 사용합니다. guest 로그인은 비운영 환경에서 허용되고, production에서는 `PUBLIC_PLAYTEST_ENABLED=true`일 때만 열립니다.

검증 명령:

```bash
pnpm test
pnpm typecheck
pnpm build
```

## 저장소 구성

```text
apps/
├─ web/                         Next.js·React·Phaser UI와 REST/OAuth BFF
└─ game-server/                 Colyseus party_room과 서버 시뮬레이션

packages/
├─ auth/                        OAuth 보조·세션 암호·게임 티켓 JWT
├─ db/                          PostgreSQL schema·Drizzle repository·migration
├─ game-core/                   Phaser 비의존 게임 규칙과 0.2 공용 규칙
└─ protocol/                    client/server 공용 Zod protocol v4

Document/                       기획·밸런스·기술·협업 문서
```

## 핵심 문서

- [`Document/0.2버전_명세서.md`](./Document/0.2버전_명세서.md): 확정 규칙, 구현 상태, 미결정 선택지
- [`Document/0.2버전_밸런스_데이터.md`](./Document/0.2버전_밸런스_데이터.md): 0.2 수치 원본과 승인 대기 값
- [`Document/0.2버전_변경사항.md`](./Document/0.2버전_변경사항.md): 0.1 대비 변경과 남은 작업
- [`Document/backend_node_colyseus_postgresql.md`](./Document/backend_node_colyseus_postgresql.md): 백엔드 실제 구현·부분 구현·목표
- [`Document/technical_design_and_architecture.md`](./Document/technical_design_and_architecture.md): 기술·게임플레이 아키텍처
- [`Document/3인_개발_역할분담_보고서.md`](./Document/3인_개발_역할분담_보고서.md): 시스템·레벨·백엔드 협업 경계
- [`Document/협업_데이터_계약_초안.txt`](./Document/협업_데이터_계약_초안.txt): protocol v2 기반 공통 데이터 계약
- [`Document/aws_lightsail_deployment.md`](./Document/aws_lightsail_deployment.md): 단일 호스트 MVP 배포·운영 런북
