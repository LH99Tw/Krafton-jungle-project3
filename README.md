# Krafton Jungle Project 3 — 《5일 뒤 마왕》

로그라이트·디펜스·RPG·타이쿤을 결합한 데스크톱 웹 게임 미니 프로젝트입니다.

## 구현 상태와 기술 스택

Cloudflare/Vinext/D1 런타임은 제거했습니다. 현재 저장소는 표준 Next.js Node 서버, Colyseus, Drizzle ORM, PostgreSQL, OAuth + 서버 세션 + 게임 티켓 JWT로 로컬에서 실행됩니다. Phaser 프로토타입의 화면과 싱글 플레이 콘텐츠는 그대로 유지하며, Colyseus가 접속·Room·플레이어 이동·페이즈·결과 저장의 서버 경계를 담당합니다. 전투·건설 규칙 전체의 서버 권위화는 [`packages/game-core`](./packages/game-core)로 단계적으로 옮기는 중입니다.

백엔드 계약과 남은 권위화 순서는 [`Document/backend_node_colyseus_postgresql.md`](./Document/backend_node_colyseus_postgresql.md), AWS 무료 범위를 고려한 MVP 배포·운영 절차는 [`Document/aws_lightsail_deployment.md`](./Document/aws_lightsail_deployment.md)를 참고하세요.

## 로컬 실행

Node.js 22.13+, pnpm 11, Docker가 필요합니다.

```bash
pnpm install
pnpm local:setup
pnpm local:up
pnpm db:migrate
pnpm dev
```

웹은 `http://localhost:3000`, Colyseus는 `ws://localhost:2567`, 로컬 PostgreSQL은 충돌을 피하기 위해 호스트 `55432` 포트를 사용합니다. 개발 환경에서는 Cognito 설정 없이 로컬 사용자로 로그인할 수 있습니다.

## 저장소 구성

```text
apps/
├─ web/                        Next.js·React·Phaser 웹과 REST/OAuth API
└─ game-server/                Colyseus 3인 party_room 서버

packages/
├─ auth/                       OAuth 상태·세션 암호·게임 JWT
├─ db/                         PostgreSQL 스키마·Drizzle 저장소·migration
├─ game-core/                  Phaser 비의존 서버 게임 규칙
└─ protocol/                   Zod 기반 버전 명령 계약

Document/                    기획·설계·협업 문서
├─ 3인_개발_역할분담_보고서.md    시스템/레벨/백엔드 협업 보고서
├─ backend_node_colyseus_postgresql.md
│                                Node·Colyseus·PostgreSQL 설계와 구현 현황
├─ aws_lightsail_deployment.md    AWS Lightsail 배포·운영 런북
├─ 협업_데이터_계약_초안.txt      공통 ID·명령·스냅숏 계약
├─ 게임기획서_고도화_초안.md      고도화된 게임 기획서
├─ 프로토타입_제안서.md            제작 범위와 완료 기준
└─ 기획서·추가입력 관련 원문       분석 근거 자료
```

실행법과 구현 현황은 [`apps/web/README.md`](./apps/web/README.md), 모듈 책임과 확장 경계는 [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md)를 참고하세요.
