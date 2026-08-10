# AWS Lightsail MVP 배포·운영 런북

> 상태: Docker Compose·Caddy·CI/CD 파일 구현 완료, 실제 AWS 계정 배포 전 검증 기준
> 기준일: 2026-08-10
> 리전: 서울 `ap-northeast-2`
> 대상: 동시접속 10~20명 시연용 MVP

## 1. 결론과 비용 기준

AWS에서 이 시스템을 영구적으로 완전 무료 운영할 수 있다고 가정하지 않는다.

- 신규 AWS 고객은 최대 6개월 Free Plan과 기본 100달러, 조건 충족 시 총 200달러까지 크레딧을 받을 수 있다.
- Lightsail Linux 2GB/2vCPU/60GB 번들은 공식 표준 가격이 월 12달러이며 일부 번들의 첫 3개월 무료 혜택 대상이다.
- Cognito User Pool Lite/Essentials의 직접·소셜 로그인은 월 10,000 MAU까지 지속 무료 구간이 있다.
- Lightsail 번들은 고정 IP와 전송량을 묶어 제공하지만 S3, snapshot, 등록 도메인 등은 별도 비용이 생길 수 있다.
- 무료 플랜/크레딧과 서비스 제공 조건은 계정 생성일과 정책 변경에 영향을 받으므로 생성 전 Billing 콘솔에서 다시 확인한다.

공식 참고:

- [AWS Free Tier FAQ](https://aws.amazon.com/free/free-tier-faqs/)
- [AWS Free Plan 안내](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html)
- [Lightsail 가격](https://aws.amazon.com/lightsail/pricing/)
- [Cognito 가격](https://aws.amazon.com/cognito/pricing/)

무료 기간 종료 후 예상 최저 고정비는 Lightsail 월 12달러다. 작은 S3 백업 비용과 세금은 별도다. 자체 도메인을 구입하면 등록·갱신 비용도 추가된다.

## 2. MVP 인프라 결정

```text
Internet
   │ HTTPS/WSS 443
   ▼
Lightsail static IP
   │
   ▼
Caddy container (80/443 only)
├─ web.<duckdns>  ─────> Next.js :3000
└─ game.<duckdns> ─────> Colyseus :2567

Docker private network
├─ web
├─ game-server
├─ postgres :5432
└─ migrate (one-shot)

External managed services
├─ Cognito User Pool Lite
├─ Google OAuth
└─ S3 encrypted backup bucket
```

MVP에서는 다음 AWS 리소스를 만들지 않는다.

- NAT Gateway
- Application Load Balancer
- RDS
- ElastiCache
- ECS/Fargate/EKS
- Route 53 hosted zone
- Secrets Manager

단일 서버이므로 서버 장애, 디스크 손실, 배포 중 짧은 중단을 허용한다. 이 제약은 사용자 시연과 팀 운영 문서에 명시한다.

## 3. 이름과 환경 구분

예시 값은 다음을 사용한다. 실제 생성 시 프로젝트에 맞게 한 번 정하고 모든 설정에서 동일하게 사용한다.

```text
AWS region:             ap-northeast-2
Lightsail instance:     five-days-mvp
Static IP:              five-days-mvp-ip
Backup bucket:          five-days-mvp-backup-<account-id>
Web hostname:           five-days-web.duckdns.org
Game hostname:          five-days-game.duckdns.org
Docker directory:       /opt/five-days
Compose project:        five-days
```

운영과 개발은 DB와 Cognito app client를 공유하지 않는다. MVP Lightsail은 `staging` 겸 시연 환경으로 취급하고 로컬 개발은 Docker Compose의 별도 database를 사용한다.

## 4. AWS 계정과 비용 안전장치

### 4.1 계정 생성 직후

1. root 계정에 MFA를 설정한다.
2. 일상 작업용 IAM 관리자 사용자를 만들고 root access key는 만들지 않는다.
3. Billing alert 수신 이메일을 팀 공용 주소로 설정한다.
4. Cost Explorer와 Free Tier usage alert를 활성화한다.
5. AWS Budget를 월 5달러, 10달러, 20달러에 각각 만든다.
6. 각 Budget의 80% forecast와 100% actual 알림을 이메일로 전송한다.
7. 한 리전 `ap-northeast-2`만 사용하고 불필요한 리소스가 다른 리전에 생기지 않았는지 매주 확인한다.

Free Plan 계정은 일부 서비스가 제한될 수 있다. Lightsail, Cognito, S3 사용 가능 여부와 남은 credit은 배포 전에 Billing의 Credits/Free Tier 화면에서 확인한다.

### 4.2 비용을 키우는 실수 방지

- 사용하지 않는 static IP, snapshot, S3 multipart upload를 즉시 정리한다.
- 인스턴스를 중지해도 저장소/snapshot 비용은 남을 수 있음을 인지한다.
- RDS, ALB, NAT Gateway, ElastiCache를 테스트 목적으로 생성하지 않는다.
- S3 backup lifecycle을 반드시 적용한다.
- CloudWatch에 고용량 debug 로그를 장기 보관하지 않는다.
- GitHub Actions 실패 loop가 반복 배포되지 않도록 concurrency를 1로 제한한다.

## 5. Lightsail 생성

### 5.1 AWS CLI 준비

로컬 AWS CLI에 IAM 사용자 또는 SSO 프로필을 구성한 뒤 확인한다.

```bash
aws sts get-caller-identity
aws configure get region
```

대상 리전의 현재 blueprint와 bundle ID는 하드코딩하지 않고 조회한다.

```bash
AWS_REGION=ap-northeast-2
aws lightsail get-blueprints --region "$AWS_REGION" --include-inactive
aws lightsail get-bundles --region "$AWS_REGION" --include-inactive
```

출력에서 Ubuntu 24.04 LTS blueprint와 Linux 2GB/2vCPU/60GB, 월 12달러 bundle ID를 확인한다.

### 5.2 인스턴스와 고정 IP

```bash
AWS_REGION=ap-northeast-2
INSTANCE_NAME=five-days-mvp
STATIC_IP_NAME=five-days-mvp-ip
BLUEPRINT_ID=<조회한-ubuntu-24.04-blueprint-id>
BUNDLE_ID=<조회한-2gb-bundle-id>

aws lightsail create-instances \
  --region "$AWS_REGION" \
  --instance-names "$INSTANCE_NAME" \
  --availability-zone ap-northeast-2a \
  --blueprint-id "$BLUEPRINT_ID" \
  --bundle-id "$BUNDLE_ID"

aws lightsail allocate-static-ip \
  --region "$AWS_REGION" \
  --static-ip-name "$STATIC_IP_NAME"

aws lightsail attach-static-ip \
  --region "$AWS_REGION" \
  --static-ip-name "$STATIC_IP_NAME" \
  --instance-name "$INSTANCE_NAME"

aws lightsail get-static-ip \
  --region "$AWS_REGION" \
  --static-ip-name "$STATIC_IP_NAME"
```

availability zone이 계정에서 선택 불가능하면 `aws lightsail get-regions --include-availability-zones` 결과 중 서울 리전 zone을 사용한다.

### 5.3 방화벽

Lightsail Networking 화면에서 다음만 허용한다.

| 포트 | 소스 | 목적 |
|---|---|---|
| TCP 22 | 팀의 고정 공인 IP `/32` | SSH 배포·장애 대응 |
| TCP 80 | 전체 IPv4/IPv6 | ACME 및 HTTPS redirect |
| TCP 443 | 전체 IPv4/IPv6 | 웹과 WSS |

`3000`, `2567`, `5432`는 공개하지 않는다. 팀 공인 IP가 바뀌면 SSH rule을 갱신하며 임시로 `0.0.0.0/0`을 열어두지 않는다.

## 6. 서버 초기화

Lightsail SSH key로 접속한 뒤 Ubuntu를 갱신한다.

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl gnupg awscli jq
```

Docker 공식 apt 저장소를 구성하고 Engine과 Compose plugin을 설치한다.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

UBUNTU_CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $UBUNTU_CODENAME stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

배포 디렉터리를 만들고 deploy 사용자에게만 권한을 준다.

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy -m 0750 /opt/five-days
sudo install -d -o deploy -g deploy -m 0750 /opt/five-days/backups
```

SSH 공개키를 `deploy` 사용자의 `authorized_keys`에 추가하고 로그인 확인 후 Ubuntu 기본 사용자의 불필요한 배포 권한을 줄인다. 비밀번호 SSH와 root SSH는 비활성화한다.

### 6.1 swap

2GB 인스턴스에서 build는 CI가 담당하지만 일시적인 메모리 급증에 대비해 2GB swap을 둔다.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

swap은 성능 확장 수단이 아니다. 지속적인 swap 사용이 발생하면 인스턴스 상향 또는 서비스 분리를 검토한다.

## 7. 무료 DNS와 HTTPS

자체 도메인이 없으므로 DuckDNS에서 서로 다른 두 이름을 만든다.

```text
five-days-web.duckdns.org  -> Lightsail static IP
five-days-game.duckdns.org -> Lightsail static IP
```

고정 IP가 변경될 때만 DuckDNS 레코드를 수정한다. DuckDNS token은 서버 또는 저장소에 둘 필요가 없고 DNS 설정 시에만 사용한다.

Caddy 목표 설정:

```caddyfile
five-days-web.duckdns.org {
    encode zstd gzip
    reverse_proxy web:3000
}

five-days-game.duckdns.org {
    encode zstd gzip
    reverse_proxy game-server:2567
}
```

Caddy가 Let's Encrypt 인증서를 발급·갱신한다. 두 이름 모두 public DNS에서 static IP로 확인되고 80/443이 열린 이후 Caddy를 시작한다.

정식 운영 전에는 소유 도메인을 구입하고 `app.example.com`, `game.example.com`으로 교체한다. Cognito와 Google의 callback/logout URL도 같은 배포에서 함께 변경한다.

## 8. Docker Compose 배포 토폴로지

저장소의 `compose.yml`, `Caddyfile`, `Dockerfile.web`, `Dockerfile.game`을 `/opt/five-days`에 배치한다. `deploy/env/*.example`을 기준으로 실제 환경 파일을 만들되 placeholder는 반드시 새 비밀값으로 교체한다.

```bash
cd /opt/five-days
cp deploy/env/host.example .env
cp deploy/env/web.example .env.web
cp deploy/env/game.example .env.game
cp deploy/env/migration.example .env.migration
cp deploy/env/postgres.example .env.postgres
chmod 0600 .env .env.web .env.game .env.migration .env.postgres
```

`GAME_SERVER_PUBLIC_URL`은 브라우저가 접근할 `wss://` 주소이며 Next.js가 요청 시 페이지 속성으로 전달하므로 Docker 이미지에 고정하지 않는다. 목표 토폴로지는 다음과 같다.

```yaml
services:
  caddy:
    image: caddy:<pinned-version>
    ports: ["80:80", "443:443"]
    depends_on: [web, game-server]

  web:
    image: ghcr.io/<owner>/five-days-web:<git-sha>
    expose: ["3000"]
    env_file: [.env.web]
    depends_on:
      postgres:
        condition: service_healthy

  game-server:
    image: ghcr.io/<owner>/five-days-game-server:<git-sha>
    expose: ["2567"]
    env_file: [.env.game]
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:<pinned-major-and-minor>
    expose: ["5432"]
    env_file: [.env.postgres]
    volumes: ["postgres-data:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]

  migrate:
    image: ghcr.io/<owner>/five-days-web:<git-sha>
    profiles: ["migration"]
    env_file: [.env.migration]
    command: ["pnpm", "db:migrate"]

volumes:
  postgres-data:
  caddy-data:
  caddy-config:
```

운영 원칙:

- 모든 image tag는 `latest`가 아니라 Git SHA로 고정한다.
- PostgreSQL major/minor를 고정하고 자동 major upgrade를 하지 않는다.
- `restart: unless-stopped`와 container health check를 설정한다.
- web과 game-server에는 메모리 상한을 설정해 PostgreSQL과 host를 보호한다.
- `.env.web`, `.env.game`, `.env.migration`, `.env.postgres`, `.env.backup`과 JWT key는 `/opt/five-days`에 mode `0600`으로 저장하고 Git에 포함하지 않는다.
- game-ticket private key는 `.env.web` 또는 web 전용 key file에만 두고 game-server에는 공개키만 제공한다.
- 단일 서버 MVP는 운영 복잡도를 줄이기 위해 앱과 migration이 전용 `five_days_app` role 하나를 공유한다. RDS 전환 시 migration owner와 제한된 앱 role을 분리한다.

권장 2GB 메모리 예산:

| 서비스 | 목표 상한 |
|---|---:|
| PostgreSQL | 512MiB |
| Next.js | 512MiB |
| Colyseus | 512MiB |
| Caddy/OS 여유 | 512MiB |

## 9. Cognito + Google OAuth

### 9.1 Google 설정

Google Cloud Console에서 OAuth consent screen과 Web application client를 만든다.

Google authorized redirect URI는 Cognito가 제공한 federation callback으로 설정한다.

```text
https://<cognito-domain>/oauth2/idpresponse
```

Google client ID/secret은 Cognito IdP 설정에만 저장한다. 애플리케이션 컨테이너에는 주입하지 않는다.

### 9.2 Cognito User Pool

1. 서울 리전에 User Pool을 만든다.
2. pricing tier는 Lite를 선택하고 Advanced Security Features는 MVP에서 끈다.
3. Google을 social identity provider로 추가한다.
4. attribute mapping은 Google `sub`, `email`, `name`을 사용한다.
5. app client는 authorization code grant만 켠다.
6. scope는 `openid email profile`만 허용한다.
7. PKCE `S256`을 사용하고 implicit grant는 끈다.
8. access token은 15분, ID token은 15분, refresh token은 7일로 설정한다.
9. MFA는 MVP에서 optional로 두되 관리 계정에는 AWS MFA를 별도로 사용한다.

Cognito callback URL:

```text
https://five-days-web.duckdns.org/api/auth/callback
```

Cognito logout URL:

```text
https://five-days-web.duckdns.org/
```

Google과 Cognito 모두 URL 문자열을 정확히 일치시킨다. HTTP, IP 주소, wildcard callback은 허용하지 않는다.

### 9.3 애플리케이션 세션

Next.js callback은 Cognito token을 검증한 뒤 PostgreSQL 서버 세션을 만든다. 브라우저에는 불투명 HttpOnly 세션 쿠키만 둔다. Colyseus 접속에는 `/api/game-ticket`에서 발급한 90초 JWT를 사용한다. 세부 계약은 백엔드 아키텍처 문서를 따른다.

## 10. GitHub Actions 배포

GitHub Environments에 `staging`을 만들고 다음 secret을 등록한다.

```text
LIGHTSAIL_HOST
LIGHTSAIL_DEPLOY_USER
LIGHTSAIL_SSH_PRIVATE_KEY
GHCR_READ_TOKEN
```

GitHub Actions에는 Lightsail을 직접 변경할 AWS key가 필요하지 않으며 SSH로 배포한다. GHCR package가 public이면 `GHCR_READ_TOKEN`도 생략한다. S3 backup용 IAM access key는 서버의 `.env.backup`에 mode `0600`으로 저장하고 지정 bucket prefix의 put/list/get/delete만 허용한다. 전체 관리자 권한을 주지 않는다.

배포 workflow 순서:

1. main push 또는 수동 dispatch를 받는다.
2. 같은 환경의 이전 run을 취소하도록 concurrency key를 설정한다.
3. `pnpm install --frozen-lockfile`, lint, unit, integration, build를 실행한다.
4. web/game 이미지를 각각 Git SHA tag로 빌드해 GHCR에 push한다.
5. SSH로 서버에 접속해 현재 image tag를 `.previous-release`에 기록한다.
6. 새 compose image tag를 설정하고 image를 pull한다.
7. `docker compose --profile migration run --rm migrate`를 한 번 실행한다.
8. migration 성공 후 `docker compose up -d --remove-orphans`를 실행한다.
9. web/game readiness endpoint를 최대 60초 확인한다.
10. 실패 시 컨테이너 로그를 수집하고 이전 image tag로 rollback한다.

단일 서버이므로 migration과 container 교체 동안 짧은 중단을 허용한다. migration이 destructive하면 자동 rollback으로 DB schema를 되돌리지 않고 배포를 중단한 뒤 백업 복구 절차를 따른다.

## 11. 배포 명령

서버에서 수동 확인 또는 장애 대응 시 다음 순서를 사용한다.

```bash
cd /opt/five-days
docker compose config --quiet
docker compose pull
docker compose --profile migration run --rm migrate
docker compose up -d --remove-orphans
docker compose ps
curl --fail --silent --show-error https://five-days-web.duckdns.org/api/health/ready
curl --fail --silent --show-error https://five-days-game.duckdns.org/health/ready
```

로그는 token이나 환경 변수를 출력하지 않도록 애플리케이션에서 redact한다.

```bash
docker compose logs --since=15m --tail=300 web
docker compose logs --since=15m --tail=300 game-server
docker compose logs --since=15m --tail=200 postgres
```

## 12. PostgreSQL 백업

### 12.1 S3 bucket

bucket 이름은 전역 유일해야 하며 서울 리전에 만든다.

```bash
AWS_REGION=ap-northeast-2
BACKUP_BUCKET=five-days-mvp-backup-<account-id>

aws s3api create-bucket \
  --region "$AWS_REGION" \
  --bucket "$BACKUP_BUCKET" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"

aws s3api put-public-access-block \
  --bucket "$BACKUP_BUCKET" \
  --public-access-block-configuration \
'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
```

bucket default encryption은 SSE-S3를 켜고 versioning을 활성화한다. lifecycle은 backup object를 30일 후 삭제하고 미완료 multipart upload를 7일 후 정리한다.

### 12.2 일일 백업

매일 KST 04:30에 다음 동작을 systemd timer로 실행한다.

```bash
cd /opt/five-days
BACKUP_FILE="backups/five-days-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker compose exec -T postgres \
  pg_dump --format=custom --no-owner --no-acl \
  --username "$POSTGRES_USER" "$POSTGRES_DB" > "$BACKUP_FILE"

test -s "$BACKUP_FILE"
aws s3 cp "$BACKUP_FILE" "s3://$BACKUP_BUCKET/postgres/" \
  --region ap-northeast-2 \
  --sse AES256

find /opt/five-days/backups -type f -name '*.dump' -mtime +7 -delete
```

실제 script는 `.env.postgres`를 안전하게 읽되 `set -x`를 사용하지 않고 secret을 출력하지 않는다. 실패 시 비정상 종료하고 알림을 보낸다.

### 12.3 월 1회 복구 훈련

운영 DB를 덮어쓰지 않고 임시 DB로 복구한다.

```bash
cd /opt/five-days
docker compose exec -T postgres createdb -U "$POSTGRES_USER" restore_check
docker compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" \
  -d restore_check \
  --no-owner --no-acl < backups/<검증할-backup>.dump

docker compose exec -T postgres psql \
  -U "$POSTGRES_USER" \
  -d restore_check \
  -c 'SELECT count(*) FROM users;'

docker compose exec -T postgres dropdb -U "$POSTGRES_USER" restore_check
```

복구 일시, backup key, 검증 결과, 수행자를 운영 기록에 남긴다.

## 13. 롤백

### 13.1 애플리케이션만 롤백

1. `.previous-release`의 web/game SHA를 확인한다.
2. compose image tag를 이전 SHA로 되돌린다.
3. `docker compose pull`과 `up -d`를 실행한다.
4. readiness와 로그인/방명록/Room 생성 smoke test를 실행한다.

### 13.2 migration 이후 롤백

- additive migration이면 이전 애플리케이션이 새 schema에서 동작하도록 expand/contract 정책을 지킨다.
- destructive migration 실패는 자동 down migration을 실행하지 않는다.
- 서비스를 maintenance 상태로 바꾸고 새 DB에 최근 dump를 복구한 뒤 연결 문자열을 전환한다.
- 복구 후 손실 가능한 시간 범위는 마지막 성공 backup 이후임을 사용자에게 고지한다.

## 14. 모니터링과 장애 대응

MVP 최소 알림:

- Lightsail CPU 70% 이상 15분
- 메모리 또는 swap 지속 증가
- disk 80% 이상
- container restart
- web/game readiness 3회 연속 실패
- backup 실패 또는 26시간 이상 성공 기록 없음
- 월 비용 5/10/20달러 경보

장애 확인 순서:

1. Caddy와 DNS/인증서
2. web/game container health
3. PostgreSQL health와 disk
4. 최근 배포와 migration
5. Cognito/Google callback 설정
6. host CPU, memory, event-loop lag

서비스 비밀정보와 사용자 token을 장애 채널에 붙여넣지 않는다.

## 15. 확장 전환 기준과 목표

다음 조건이 발생하면 단일 Lightsail을 유지하지 않는다.

- 단일 인스턴스 장애가 허용되지 않음
- CPU 70% 또는 event-loop lag p95 50ms를 반복 초과
- 디스크/DB 부하 때문에 game tick이 영향받음
- 동시접속 20명 또는 Room 수가 지속 증가
- 배포 중단을 허용할 수 없음

확장 목표:

```text
Route 53 + ACM
        │
        ▼
ALB (HTTPS/WSS)
├─ Next.js service (2+ instances)
└─ Colyseus processes (2+)
       ├─ Redis Presence
       └─ Redis Driver

RDS PostgreSQL Multi-AZ
ElastiCache Redis/Valkey
S3 backup
```

전환 순서:

1. PostgreSQL을 RDS Single-AZ로 이전하고 애플리케이션 연결만 변경한다.
2. Redis Presence/Driver, rate limit, game-ticket jti 저장소를 추가한다.
3. Colyseus public address와 ALB WebSocket timeout을 설정한다.
4. web/game을 독립적으로 두 개 이상 실행한다.
5. RDS Multi-AZ와 정식 도메인을 적용한다.
6. 부하·장애 전환·재접속 테스트 후 Lightsail을 종료한다.

ALB는 WebSocket을 지원하지만 ALB, RDS, ElastiCache, 다중 compute 비용이 모두 발생하므로 무료 MVP 범위가 아니다.

## 16. 배포 완료 체크리스트

- [ ] AWS root MFA와 IAM 작업 계정이 설정됨
- [ ] 5/10/20달러 Budget 알림이 수신됨
- [ ] Lightsail 2GB 인스턴스와 static IP가 생성됨
- [ ] 22/80/443 외 포트가 닫힘
- [ ] DuckDNS 두 이름이 static IP를 가리킴
- [ ] Caddy 인증서가 정상 발급됨
- [ ] Cognito + Google callback/logout URL이 일치함
- [ ] PostgreSQL이 외부에서 접근되지 않음
- [ ] migration이 빈 DB에서 성공함
- [ ] GitHub Actions가 SHA image를 배포함
- [ ] web/game readiness가 성공함
- [ ] 로그인, 방명록, 3인 Room, 결과 저장 smoke test가 성공함
- [ ] S3 backup이 생성되고 local backup 7일 보관이 동작함
- [ ] 새 DB 복구 훈련이 성공함
- [ ] 이전 image rollback이 성공함
- [ ] 무료 기간 종료일과 credit 잔액이 팀 캘린더에 기록됨
