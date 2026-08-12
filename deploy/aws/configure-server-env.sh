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
WEB_HOST="${WEB_HOST:-five-days-web.duckdns.org}"
GAME_HOST="${GAME_HOST:-five-days-game.duckdns.org}"
SERVER_ENV_DIR="$SECRET_DIR/server-env"

install -d -m 0700 "$SERVER_ENV_DIR"
if [ ! -f "$SECRET_DIR/game-ticket-private.pem" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$SECRET_DIR/game-ticket-private.pem" 2>/dev/null
  openssl pkey -in "$SECRET_DIR/game-ticket-private.pem" -pubout -out "$SECRET_DIR/game-ticket-public.pem" 2>/dev/null
  chmod 0600 "$SECRET_DIR/game-ticket-private.pem" "$SECRET_DIR/game-ticket-public.pem"
fi
if [ ! -f "$SECRET_DIR/runtime-secrets.env" ]; then
  umask 077
  printf 'POSTGRES_PASSWORD=%s\nAUTH_SESSION_ENCRYPTION_KEY=%s\nFASTLANE_SECRET=%s\nGUESTBOOK_MASTER_KEY=%s\n' \
    "$(openssl rand -base64 36 | tr -d '\n')" \
    "$(openssl rand -base64 32 | tr -d '\n')" \
    "$(openssl rand -base64 48 | tr -d '\n')" \
    "$(openssl rand -base64 48 | tr -d '\n')" > "$SECRET_DIR/runtime-secrets.env"
elif ! grep -q '^FASTLANE_SECRET=' "$SECRET_DIR/runtime-secrets.env"; then
  umask 077
  printf 'FASTLANE_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> "$SECRET_DIR/runtime-secrets.env"
fi
if ! grep -q '^GUESTBOOK_MASTER_KEY=' "$SECRET_DIR/runtime-secrets.env"; then
  umask 077
  guestbook_master_key="$(awk -F= '/^GUESTBOOK_ADMIN_DELETE_KEY=/{sub(/^[^=]*=/, ""); print; exit}' "$SECRET_DIR/runtime-secrets.env")"
  if [ "${#guestbook_master_key}" -lt 32 ]; then
    guestbook_master_key="$(openssl rand -base64 48 | tr -d '\n')"
  fi
  printf 'GUESTBOOK_MASTER_KEY=%s\n' "$guestbook_master_key" >> "$SECRET_DIR/runtime-secrets.env"
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
  'PUBLIC_PLAYTEST_ENABLED=true' \
  'GUEST_10M_LIMIT=10' \
  'GUEST_DAILY_LIMIT=50' \
  'GUEST_GLOBAL_DAILY_LIMIT=500' \
  'GAME_TICKET_USER_PER_MINUTE=30' \
  'GAME_TICKET_IP_PER_MINUTE=60' \
  'GUESTBOOK_PER_MINUTE=5' \
  'SESSION_PER_MINUTE=120' \
  'READ_API_PER_MINUTE=60' \
  "AUTH_SESSION_ENCRYPTION_KEY=$AUTH_SESSION_ENCRYPTION_KEY" \
  "GUESTBOOK_MASTER_KEY=$GUESTBOOK_MASTER_KEY" \
  "GAME_TICKET_PRIVATE_KEY_BASE64=$private_key_base64" \
  'GAME_TICKET_ACTIVE_KID=production-v1' \
  'PROTOCOL_VERSION=10' \
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
  'PROTOCOL_VERSION=10' \
  'FASTLANE_ENABLED=true' \
  'FASTLANE_HOST=0.0.0.0' \
  'FASTLANE_PORT=4433' \
  "FASTLANE_PUBLIC_URL=https://$GAME_HOST/fastlane" \
  "FASTLANE_SECRET=$FASTLANE_SECRET" \
  'FASTLANE_CERT_PATH=/run/secrets/fastlane/tls.crt' \
  'FASTLANE_KEY_PATH=/run/secrets/fastlane/tls.key' \
  'FASTLANE_MAINTENANCE_MS=10000' \
  'MAX_ACTIVE_LOBBIES=100' \
  'MAX_ACTIVE_GAMES=100' \
  'MAX_LIVE_INVADERS=15' \
  'MAX_WEBSOCKET_CONNECTIONS=300' \
  'MAX_HTTP_CONNECTIONS=350' \
  'WS_AUTH_PER_MINUTE=20' \
  'LOBBY_LIST_PER_MINUTE=30' \
  "SERVER_VERSION=${SERVER_VERSION:-manual-bootstrap}" \
  "ALLOWED_ORIGINS=https://$WEB_HOST" > "$SERVER_ENV_DIR/.env.game"

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

printf 'Server environment configured for https://%s, wss://%s, and WebTransport UDP 443\n' "$WEB_HOST" "$GAME_HOST"
