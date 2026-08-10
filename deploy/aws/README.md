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
- 고정 IPv4와 80/443 공개 포트
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
https://web.<STATIC_IP>.sslip.io/api/auth/callback
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
- 브라우저와 Colyseus 사이에 하나의 지속 WSS 연결 사용
- 고정 IP와 `sslip.io` DNS를 사용하고 Caddy에서 TLS 종료
- 20Hz 서버 tick과 4KB 메시지 제한 유지

한국 사용자 기준 RTT와 `tick p95`를 따로 측정합니다. 서울에서 멀리 떨어진 사용자의 물리적 RTT는 제거할 수 없으며, 이용자 지역이 바뀌면 해당 지역 게임 서버를 추가해야 합니다.
