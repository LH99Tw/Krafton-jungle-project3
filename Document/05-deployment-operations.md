# 《5일 뒤 마왕》 배포·운영 명세

> 현재 단일 호스트 AWS Lightsail 배포와 로컬 개발 절차의 단일 문서다. 실행 스크립트의 세부 사용법은 `deploy/aws/README.md`를 보조 자료로 사용한다.

## 1. 요구 환경

- Node.js 22.13 이상; CI는 22.22.3
- pnpm 11.16.0
- Docker와 Docker Compose
- PostgreSQL 17.6
- 운영: AWS 계정, Lightsail, Cognito, Google OAuth, GitHub Actions/OIDC

## 2. 로컬 실행

```bash
pnpm install
pnpm local:setup
pnpm local:up
pnpm db:migrate
pnpm dev
```

기본 주소:

| 서비스 | 주소 |
|---|---|
| Web | `http://localhost:3000` |
| Game server | `ws://localhost:2567` |
| PostgreSQL | `localhost:55432` |

Windows PowerShell 실행 정책이 `pnpm.ps1`을 막는 환경에서는 `pnpm.cmd`를 사용한다.

## 3. 로컬 검증

```bash
pnpm map:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

전체 검증은 `pnpm verify`를 사용한다. 이 명령은 production audit, lint, typecheck, deadcode, test, build를 실행한다.

공식 맵을 변경할 때:

```bash
pnpm map:generate -- --input <editor-export.json>
pnpm map:check
```

생성된 공식 맵과 원본 입력을 함께 커밋한다.

## 4. 운영 토폴로지

```text
Internet
└─ Caddy :80/:443
   ├─ Web → Next.js :3000
   ├─ Game → Colyseus :2567
   └─ WebTransport → :4433/UDP

Internal Docker network
├─ web
├─ game-server
├─ postgres
├─ migrate (profile)
└─ fastlane-cert-sync
```

Caddy만 HTTP/HTTPS를 공개한다. PostgreSQL은 외부에 공개하지 않는다. WebTransport를 사용할 경우 Lightsail UDP 4433과 인증서 동기화를 구성한다.

## 5. 필수 운영 설정

운영에서 반드시 실제 값으로 설정할 항목:

- `APP_ORIGIN=https://...`
- `GAME_SERVER_PUBLIC_URL=wss://...`
- `DATABASE_URL`, `DATABASE_SSL`
- `AUTH_SESSION_ENCRYPTION_KEY`
- `GAME_TICKET_PRIVATE_KEY_BASE64`, `GAME_TICKET_PUBLIC_KEY_BASE64`, `GAME_TICKET_ACTIVE_KID`
- `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `COGNITO_ISSUER`, `COGNITO_DOMAIN`, `COGNITO_REDIRECT_URI`
- `ALLOWED_ORIGINS`
- `GUESTBOOK_ADMIN_DELETE_KEY` 32자 이상
- `PROTOCOL_VERSION=9`

Fast lane 사용 시:

- `FASTLANE_ENABLED=true`
- `FASTLANE_PUBLIC_URL=https://<game-host>/fastlane`
- `FASTLANE_SECRET` 32자 이상
- certificate/key 경로

운영에서는 `DEV_AUTH_BYPASS=false`여야 한다. 공개 게스트를 허용할 때만 `PUBLIC_PLAYTEST_ENABLED=true`를 사용한다.

## 6. CI

PR과 main push는 다음을 수행한다.

1. 의존성 고정 설치
2. 공식 맵 재현성 확인
3. production audit
4. lint, typecheck, deadcode, test, build

현재 테스트 기준선은 255개다. 숫자 자체보다 모든 workspace 테스트가 0 failure인지 확인한다.

## 7. 배포

배포 workflow는 main CI 성공 또는 수동 `DEPLOY` 확인으로 실행한다.

1. 릴리스 SHA를 고정한다.
2. 릴리스 후보 검증을 다시 수행한다.
3. web/game 이미지를 빌드해 GHCR에 SHA tag로 push한다.
4. GitHub OIDC로 AWS 역할을 획득한다.
5. 현재 GitHub runner IP에만 SSH를 임시 개방한다.
6. compose와 Caddy 설정을 업로드한다.
7. 이전 image tag를 `.previous-release`에 기록한다.
8. 선택적으로 migration profile을 한 번 실행한다.
9. 새 컨테이너를 기동한다.
10. web/game readiness와 fast lane ready를 최대 5분 확인한다.
11. 실패하면 로그를 수집하고 이전 image로 롤백한다.
12. 임시 SSH 방화벽 규칙을 항상 닫는다.

## 8. Health와 관측

| endpoint | 의미 |
|---|---|
| Web `/api/health/live` | Next.js 프로세스 생존 |
| Web `/api/health/ready` | 웹과 DB 준비 |
| Game `/health/live` | 게임 서버, fast lane, realtime 지표 |
| Game `/health/ready` | 게임 서버와 DB 준비 |

게임 서버 live 지표에서 확인할 항목:

- WebTransport/WSS 입력 비율
- simulation, schema sync, world frame 처리 시간
- 방·연결·재접속 lifecycle 카운터
- 침략자 hot/warm/cold 수와 대기열
- 경로 재계획 backlog와 cap hit
- 결과 저장 실패 로그

준비 상태는 5초 캐시하므로 단일 실패 요청보다 연속 실패를 장애 판단 기준으로 삼는다.

## 9. 장애 대응

우선 확인 순서:

1. DNS, Caddy, 인증서
2. web/game container health
3. PostgreSQL health와 disk
4. 최근 배포 SHA와 migration
5. Cognito/Google callback URL
6. host CPU, memory, event-loop 지연
7. fast lane이 degraded일 때 WSS fallback 정상 여부

네트워크 장애 시 현재 클라이언트가 로컬 게임으로 폴백할 수 있으므로, 서버 룸·DB match 존재 여부로 실제 온라인 런인지 확인한다.

## 10. 백업과 복구

- PostgreSQL 볼륨을 유일한 영속 데이터로 취급한다.
- 운영 DB를 매일 `pg_dump`해 암호화된 S3 bucket에 보관한다.
- bucket versioning과 lifecycle을 설정한다.
- 백업 성공 여부와 파일 크기를 알림으로 확인한다.
- 월 1회 별도 DB에서 복구 훈련을 수행한다.
- migration 전에는 즉시 복구 가능한 백업을 만든다.

애플리케이션 롤백은 `.previous-release`의 web/game SHA로 되돌린다. migration 롤백은 자동으로 가정하지 않으며 호환 가능한 순방향 migration을 기본 원칙으로 한다.

## 11. 용량과 확장 기준

단일 Lightsail MVP는 배포 workflow에서 `MAX_ACTIVE_GAMES=8`, `MAX_LIVE_INVADERS=50`을 사용한다. 부하 기준을 넘기면 새 기능보다 먼저 다음을 검토한다.

1. PostgreSQL을 RDS로 분리한다.
2. Redis 기반 Colyseus presence/driver와 공유 rate limit을 추가한다.
3. web과 game server를 독립 확장한다.
4. public address와 load balancer WebSocket timeout을 설정한다.
5. 다중 인스턴스 재접속·장애 전환 테스트 후 단일 호스트를 종료한다.
