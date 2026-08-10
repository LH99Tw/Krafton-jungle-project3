#!/usr/bin/env bash
set -euo pipefail

: "${LIGHTSAIL_HOST:?Set LIGHTSAIL_HOST to the static IPv4 address}"
: "${COGNITO_USER_POOL_ID:?Set COGNITO_USER_POOL_ID}"
: "${COGNITO_CLIENT_ID:?Set COGNITO_CLIENT_ID}"
: "${COGNITO_DOMAIN:?Set COGNITO_DOMAIN including https://}"

DEPLOY_USER="${DEPLOY_USER:-deploy}"
AWS_REGION_NAME="${AWS_REGION_NAME:-ap-northeast-2}"
SECRET_DIR="${SECRET_DIR:-deploy/.secrets}"
SSH_KEY_FILE="${SSH_KEY_FILE:-$SECRET_DIR/five-days-lightsail.pem}"
WEB_HOST="${WEB_HOST:-web.$LIGHTSAIL_HOST.sslip.io}"
GAME_HOST="${GAME_HOST:-game.$LIGHTSAIL_HOST.sslip.io}"
SERVER_ENV_DIR="$SECRET_DIR/server-env"

install -d -m 0700 "$SERVER_ENV_DIR"
if [ ! -f "$SECRET_DIR/game-ticket-private.pem" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$SECRET_DIR/game-ticket-private.pem" 2>/dev/null
  openssl pkey -in "$SECRET_DIR/game-ticket-private.pem" -pubout -out "$SECRET_DIR/game-ticket-public.pem" 2>/dev/null
  chmod 0600 "$SECRET_DIR/game-ticket-private.pem" "$SECRET_DIR/game-ticket-public.pem"
fi
if [ ! -f "$SECRET_DIR/runtime-secrets.env" ]; then
  umask 077
  printf 'POSTGRES_PASSWORD=%s\nAUTH_SESSION_ENCRYPTION_KEY=%s\n' \
    "$(openssl rand -base64 36 | tr -d '\n')" \
    "$(openssl rand -base64 32 | tr -d '\n')" > "$SECRET_DIR/runtime-secrets.env"
fi

set -a
# shellcheck source=/dev/null
. "$SECRET_DIR/runtime-secrets.env"
set +a
private_key_base64="$(base64 < "$SECRET_DIR/game-ticket-private.pem" | tr -d '\n')"
public_key_base64="$(base64 < "$SECRET_DIR/game-ticket-public.pem" | tr -d '\n')"
cognito_issuer="https://cognito-idp.$AWS_REGION_NAME.amazonaws.com/$COGNITO_USER_POOL_ID"
callback_url="https://$WEB_HOST/api/auth/callback"

umask 077
printf 'WEB_HOST=%s\nGAME_HOST=%s\n' "$WEB_HOST" "$GAME_HOST" > "$SERVER_ENV_DIR/.env"
printf 'POSTGRES_DB=five_days\nPOSTGRES_USER=five_days_app\nPOSTGRES_PASSWORD=%s\n' \
  "$POSTGRES_PASSWORD" > "$SERVER_ENV_DIR/.env.postgres"
printf 'NODE_ENV=production\nDATABASE_URL=postgresql://five_days_app:%s@postgres:5432/five_days\nDATABASE_SSL=false\n' \
  "$POSTGRES_PASSWORD" > "$SERVER_ENV_DIR/.env.migration"
printf '%s\n' \
  'NODE_ENV=production' \
  'PORT=3000' \
  "APP_ORIGIN=https://$WEB_HOST" \
  "GAME_SERVER_PUBLIC_URL=wss://$GAME_HOST" \
  "ALLOWED_ORIGINS=https://$WEB_HOST" \
  "DATABASE_URL=postgresql://five_days_app:$POSTGRES_PASSWORD@postgres:5432/five_days" \
  'DATABASE_SSL=false' \
  'DB_POOL_MAX=10' \
  'DEV_AUTH_BYPASS=false' \
  "AUTH_SESSION_ENCRYPTION_KEY=$AUTH_SESSION_ENCRYPTION_KEY" \
  "GAME_TICKET_PRIVATE_KEY_BASE64=$private_key_base64" \
  'GAME_TICKET_ACTIVE_KID=production-v1' \
  "COGNITO_REGION=$AWS_REGION_NAME" \
  "COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID" \
  "COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID" \
  "COGNITO_ISSUER=$cognito_issuer" \
  "COGNITO_DOMAIN=${COGNITO_DOMAIN%/}" \
  "COGNITO_REDIRECT_URI=$callback_url" > "$SERVER_ENV_DIR/.env.web"
printf '%s\n' \
  'NODE_ENV=production' \
  'PORT=2567' \
  "DATABASE_URL=postgresql://five_days_app:$POSTGRES_PASSWORD@postgres:5432/five_days" \
  'DATABASE_SSL=false' \
  'DB_POOL_MAX=10' \
  "GAME_TICKET_PUBLIC_KEY_BASE64=$public_key_base64" \
  'GAME_TICKET_ACTIVE_KID=production-v1' \
  'PROTOCOL_VERSION=1' \
  'MINIMUM_PLAYERS=3' \
  "SERVER_VERSION=${SERVER_VERSION:-manual-bootstrap}" \
  "ALLOWED_ORIGINS=https://$WEB_HOST" \
  'LOG_LEVEL=info' > "$SERVER_ENV_DIR/.env.game"

ssh_options=(-i "$SSH_KEY_FILE" -o StrictHostKeyChecking=accept-new)
for ((attempt = 1; attempt <= 60; attempt += 1)); do
  if ssh "${ssh_options[@]}" "$DEPLOY_USER@$LIGHTSAIL_HOST" 'test -d /opt/five-days && docker version >/dev/null 2>&1'; then
    break
  fi
  sleep 10
done
ssh "${ssh_options[@]}" "$DEPLOY_USER@$LIGHTSAIL_HOST" 'test -d /opt/five-days && docker version >/dev/null 2>&1'
scp "${ssh_options[@]}" compose.yml Caddyfile "$DEPLOY_USER@$LIGHTSAIL_HOST:/opt/five-days/"
scp "${ssh_options[@]}" "$SERVER_ENV_DIR"/.env* "$DEPLOY_USER@$LIGHTSAIL_HOST:/opt/five-days/"
ssh "${ssh_options[@]}" "$DEPLOY_USER@$LIGHTSAIL_HOST" \
  'chmod 0600 /opt/five-days/.env /opt/five-days/.env.web /opt/five-days/.env.game /opt/five-days/.env.migration /opt/five-days/.env.postgres'

printf 'Server environment configured for https://%s and wss://%s\n' "$WEB_HOST" "$GAME_HOST"
