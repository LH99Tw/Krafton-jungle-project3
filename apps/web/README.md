# 5일 뒤 마왕 — 웹 게임 프로토타입

3인의 신참 용사가 낮에는 구역을 개척하고 밤에는 기지를 방어한 뒤, 5일 안에 마왕을 토벌하는 협동 로그라이트 디펜스 RPG의 플레이 가능한 수직 슬라이스입니다.

## 실행

저장소 루트에서 Node.js 22.13 이상, pnpm 11, Docker를 사용합니다.

```bash
pnpm install
pnpm local:setup
pnpm local:up
pnpm db:migrate
pnpm dev
```

배포 빌드와 검증:

```bash
pnpm test
```

## 현재 구현

- 검사·궁수·마법사 3개 클래스와 AI 동료 2명
- WASD 이동, 포인터 조준 자동 평타, Q/E 스킬, Space 회피
- 공유 경험치와 3개 중 1개 성장 드래프트
- 베이스, 3개 구역, 게이트, 히든 엘리트, 웨이포인트 귀환
- 5일 낮·밤·정산 상태기계와 단축/정식 세션
- 포탑·장벽 자유 그리드 건설 및 3단계 강화
- 고정형 마왕의 탄막·장판·소환 패턴과 1회 후퇴
- PostgreSQL 기반 방명록·사용자 전적·서버 매치 결과 저장
- Cognito + Google OAuth, HttpOnly 서버 세션, CSRF 보호
- 90초 JWT 게임 티켓과 Colyseus `party_room` 접속
- 20Hz 서버 시뮬레이션 기반 플레이어 이동·페이즈 상태 동기화

로컬 개발에서는 Cognito 없이 개발 사용자로 로그인하며, 운영에서는 Cognito Authorization Code + PKCE를 사용합니다. 현재 Phaser 수직 슬라이스의 전투·AI·건설은 기존 로컬 플레이를 유지합니다. 멀티플레이 서버는 연결·입력·이동·시간·매치 영속화를 처리하며, 나머지 판정은 `packages/game-core`로 이전하는 순서입니다.

자세한 모듈 책임은 [ARCHITECTURE.md](./ARCHITECTURE.md)를 참고하세요.
