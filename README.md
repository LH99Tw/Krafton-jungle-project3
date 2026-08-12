# 《5일 뒤 마왕》

브라우저에서 실행되는 서버 권위형 협동 로그라이트 액션 RPG다. 솔로는 인간 1명과 서버 AI 두 명, 협동은 실제 사용자 최대 3명이 세 구역을 탐색하고 베이스를 방어한 뒤 마왕을 처치한다.

## 현재 빌드

- Next.js 16·React 19 UI와 REST BFF
- Phaser 3 렌더러
- Colyseus 권위 게임 서버와 protocol v10
- 60Hz 게임 코어, 30Hz transform frame, 10Hz Schema 동기화
- WebTransport 우선, WSS fallback
- Cognito/Google·개발·공개 게스트 인증
- PostgreSQL/Drizzle 세션·방명록·경기 결과 저장
- 공식 편집 맵 48방, 세 구역, 8개 게이트와 최종 보스
- 솔로 서버 AI, 재접속·이탈 인계, 개인 증강·장비 인벤토리, 파티 미니맵
- 장비 보급·신전·함정·체크포인트·제단 특수 방
- 방 단위 개척, 콘텐츠 마커, 웨이포인트 반경에서 목적지 마커를 선택하는 3초 순간 이동과 확장 보기를 제공하는 미니맵

현재 알려진 주요 제한은 온라인 Space 대시 입력 매핑 결함과 서버 건설 미구현이다. 게임 실행은 서버 권위 경로만 사용하며, 맵 편집기 플레이 테스트만 개발용 `editor-core`를 로컬에서 실행한다. 정확한 구현 범위와 완료 기준은 [제품·게임플레이 명세](./Document/01-product-gameplay-spec.md)를 따른다.

## 로컬 실행

Node.js 22.13 이상, pnpm 11, Docker가 필요하다.

```bash
pnpm install
pnpm local:setup
pnpm local:up
pnpm db:migrate
pnpm dev
```

| 서비스 | 기본 주소 |
|---|---|
| Web | `http://localhost:3000` |
| Colyseus | `ws://localhost:2567` |
| PostgreSQL | `localhost:55432` |

검증:

```bash
pnpm map:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Windows PowerShell 실행 정책이 `pnpm.ps1`을 차단하면 `pnpm.cmd`를 사용한다.

## 저장소 구조

```text
apps/
├─ web/                 Next.js·React·Phaser UI와 REST BFF
└─ game-server/         Colyseus 룸과 권위 시뮬레이션 호스트

packages/
├─ auth/                세션·OAuth·게임 티켓
├─ db/                  PostgreSQL Schema·repository·migration
├─ game-core/           프레임워크 독립 게임 규칙
└─ protocol/            공용 Zod protocol v10

Document/               현재 빌드의 단일 명세 집합
deploy/                 AWS·Docker 배포 보조 스크립트
```

## 문서

문서는 [Document 인덱스](./Document/README.md)에서 시작한다. 섹션별로 한 장만 유지한다.

1. [제품·게임플레이](./Document/01-product-gameplay-spec.md)
2. [밸런스](./Document/02-balance-spec.md)
3. [기술 아키텍처](./Document/03-technical-architecture.md)
4. [프로토콜·데이터](./Document/04-protocol-data-spec.md)
5. [배포·운영](./Document/05-deployment-operations.md)

버전별 변경사항과 과거 기획 초안은 별도 문서로 유지하지 않으며 Git 이력을 사용한다.

## 공식 맵

편집기 export를 공식 맵으로 반영할 때:

```bash
pnpm map:generate -- --input <editor-export.json>
pnpm map:check
```

CI와 배포는 `map:check`로 생성물 재현성을 검증한다.
