#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${INSTANCE_NAME:-five-days-mvp}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSH_KEY_FILE="${SSH_KEY_FILE:-deploy/.secrets/five-days-lightsail.pem}"
: "${LIGHTSAIL_HOST:?Set LIGHTSAIL_HOST to the static IPv4 address}"
: "${AWS_DEPLOY_ROLE_ARN:?Set AWS_DEPLOY_ROLE_ARN to the bootstrap output}"

gh secret set LIGHTSAIL_HOST --body "$LIGHTSAIL_HOST"
gh secret set LIGHTSAIL_INSTANCE_NAME --body "$INSTANCE_NAME"
gh secret set LIGHTSAIL_DEPLOY_USER --body "$DEPLOY_USER"
gh secret set AWS_DEPLOY_ROLE_ARN --body "$AWS_DEPLOY_ROLE_ARN"
gh secret set LIGHTSAIL_SSH_PRIVATE_KEY < "$SSH_KEY_FILE"

printf 'Configured repository Actions secrets for manual Lightsail deployment.\n'
