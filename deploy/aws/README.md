# AWS CLI 기반 서울 리전 배포

이 디렉터리는 Lightsail 인프라를 한 번 구성하고, 이후 배포는 GitHub Actions의 `Run workflow` 버튼으로만 실행하기 위한 스크립트입니다.

## 비용 전제

Lightsail Linux 공개 IPv4의 월 5·7·12달러 번들은 Free Tier 자격이 있는 신규 계정에서 첫 3개월, 월 750시간까지 무료 대상입니다. 계정 자격이나 기간이 다르면 생성 즉시 과금될 수 있으며 2GB `small_3_0` 번들은 무료 기간 후 월 12달러입니다. 인스턴스를 중지해도 삭제하기 전까지 스토리지 비용이 청구될 수 있습니다.

## 1. CLI 로그인

장기 Access Key 대신 AWS CLI의 콘솔 세션 로그인을 사용합니다.

```bash
aws login --profile five-days --region ap-northeast-2
aws --profile five-days --region ap-northeast-2 sts get-caller-identity
```

## 2. Lightsail과 GitHub OIDC 역할 생성

`bootstrap-lightsail.sh`는 다음 항목만 생성하거나 갱신합니다.

- 서울 `ap-northeast-2a` Ubuntu 24.04 Lightsail 2GB 인스턴스
- 고정 IPv4와 TCP 80/443, WebTransport용 UDP 443 공개 포트
- 현재 운영자 IP에만 허용된 SSH 22 포트
- 로컬 배포용 ED25519 키
- GitHub Actions가 실행 중인 runner IP만 임시로 열 수 있는 최소 권한 OIDC 역할

```bash
export BILLING_ALERT_EMAIL=<BILLING_ALERT_EMAIL>
AWS_PROFILE_NAME=five-days ./deploy/aws/bootstrap-lightsail.sh | tee deploy/.secrets/bootstrap-output.json
```

출력의 `staticIp`, `roleArn`, `webHost`, `gameHost`를 다음 단계에서 사용합니다. 스크립트는 월 실제 비용 5·10·20달러 이메일 경보가 포함된 20달러 월간 Budget 하나도 생성합니다. 무료 자격을 확인하기 전에는 이 스크립트를 실행하지 않습니다.

## 3. Cognito와 서버 환경 파일

Google Cloud OAuth client와 Cognito User Pool/Domain/Client/Google IdP를 먼저 생성합니다. callback은 다음 형식입니다.

```text
https://five-days-web.duckdns.org/api/auth/callback
```

필요한 Cognito 값을 환경 변수로 전달하면 production secret과 PostgreSQL 비밀번호를 로컬 `deploy/.secrets`에서 생성해 서버에 mode `0600`으로 전송합니다.

```bash
export LIGHTSAIL_HOST=<STATIC_IP>
export COGNITO_USER_POOL_ID=<POOL_ID>
export COGNITO_CLIENT_ID=<APP_CLIENT_ID>
export COGNITO_DOMAIN=https://<PREFIX>.auth.ap-northeast-2.amazoncognito.com
./deploy/aws/configure-server-env.sh
```

private key, DB password, Cognito 값은 Git에 포함되지 않습니다.

## 4. GitHub Actions secret 설정

```bash
export LIGHTSAIL_HOST=<STATIC_IP>
export AWS_DEPLOY_ROLE_ARN=<ROLE_ARN>
./deploy/aws/configure-github.sh
```

이 스크립트는 `LIGHTSAIL_HOST`, `LIGHTSAIL_INSTANCE_NAME`, `LIGHTSAIL_DEPLOY_USER`, `AWS_DEPLOY_ROLE_ARN`, `LIGHTSAIL_SSH_PRIVATE_KEY`를 repository Actions secrets로 저장합니다. GHCR 인증은 workflow 전용 `GITHUB_TOKEN`을 사용합니다.

## 5. 수동 배포

GitHub 저장소에서 다음 순서로 실행합니다.

1. **Actions** → **Deploy Lightsail**
2. **Run workflow**
3. `confirm`에 정확히 `DEPLOY` 입력
4. migration 실행 여부 선택

push나 pull request로는 배포되지 않습니다. workflow는 SHA 태그 이미지를 GHCR에 빌드하고 migration, health check를 수행합니다. 실패하면 이전 SHA로 되돌리고 runner의 SSH `/32` 방화벽 규칙을 항상 닫습니다.

## 지연 최소화

네트워크 레이턴시를 0으로 만들 수는 없습니다. 다음 구성으로 불필요한 지연을 제거합니다.

- 웹, Colyseus, PostgreSQL을 서울의 동일 Lightsail 인스턴스와 Docker network에 배치
- ALB, NAT Gateway, CloudFront, 외부 Redis를 경로에서 제외
- 로그인·매칭·판정은 지속 WSS를 사용하고 이동 입력·좌표는 WebTransport datagram을 우선 사용
- 고정 IP를 가리키는 `five-days-web.duckdns.org`, `five-days-game.duckdns.org`와 Caddy에서 TLS 종료
- 60Hz 고정 서버 tick, 30Hz AOI 좌표 프레임, 클라이언트 60fps 보간 사용

한국 사용자 기준 RTT와 `tick p95`를 따로 측정합니다. 서울에서 멀리 떨어진 사용자의 물리적 RTT는 제거할 수 없으며, 이용자 지역이 바뀌면 해당 지역 게임 서버를 추가해야 합니다.

## WebTransport 배포

Lightsail 배포는 `FASTLANE_ENABLED=true`가 기본입니다. Caddy가 `GAME_HOST`의 공인 인증서를 발급하면 `fastlane-cert-sync`가 전용 볼륨에 읽기 전용 사본을 만들고, game-server가 UDP 4433 리스너를 자동 시작합니다. 인증서가 아직 없으면 WSS로 서비스하면서 10초마다 재시도하고, 갱신된 인증서를 발견하면 WSS를 유지한 채 fast lane 리스너만 재시작합니다.

```dotenv
FASTLANE_ENABLED=true
FASTLANE_PUBLIC_URL=https://game.example.com/fastlane
FASTLANE_SECRET=<32자 이상의 무작위 secret>
FASTLANE_CERT_PATH=/run/secrets/fastlane/tls.crt
FASTLANE_KEY_PATH=/run/secrets/fastlane/tls.key
FASTLANE_MAINTENANCE_MS=10000
```

Caddy는 HTTP/1.1·HTTP/2만 사용해 TCP 443을 담당하고, host UDP 443은 game-server의 UDP 4433으로 전달됩니다. 배포 workflow는 `/health/live`의 `fastLane.state`가 `ready`가 될 때까지 최대 5분 기다리며, 준비되지 않으면 이전 SHA로 롤백합니다. 실행 중 UDP 장애가 발생하면 클라이언트는 자동으로 WSS에 남습니다.

## 애플리케이션 방어 범위

프로세스 내 rate limiter와 연결·로비 상한은 단일 Lightsail 인스턴스의 API 및 WebSocket 남용과 비용 고갈을 완화합니다. 분산 공격에서 프로세스별 제한 상태는 공유되지 않으며, 대규모 L3/L4 DDoS를 흡수하는 기능은 아닙니다. 트래픽 규모가 이 경계를 넘으면 유료 엣지/WAF 또는 별도 네트워크 방어를 운영 판단으로 추가해야 합니다.
