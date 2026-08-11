#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-five-days}"
AWS_REGION_NAME="${AWS_REGION_NAME:-ap-northeast-2}"
INSTANCE_NAME="${INSTANCE_NAME:-five-days-mvp}"
STATIC_IP_NAME="${STATIC_IP_NAME:-five-days-mvp-ip}"
KEY_PAIR_NAME="${KEY_PAIR_NAME:-five-days-deploy}"
BUNDLE_ID="${BUNDLE_ID:-small_3_0}"
BLUEPRINT_ID="${BLUEPRINT_ID:-ubuntu_24_04}"
OIDC_SUBJECT="${GITHUB_OIDC_SUBJECT:-repo:LH99Tw@161941871/Krafton-jungle-project3@1329446983:environment:staging}"
ROLE_NAME="${GITHUB_ROLE_NAME:-FiveDaysGitHubDeploy}"
: "${BILLING_ALERT_EMAIL:?Set BILLING_ALERT_EMAIL for the AWS Budget notifications}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRET_DIR="$PROJECT_ROOT/deploy/.secrets"
SSH_KEY_FILE="$SECRET_DIR/five-days-lightsail.pem"

aws_cli() {
  aws --profile "$AWS_PROFILE_NAME" --region "$AWS_REGION_NAME" "$@"
}

account_id="$(aws_cli sts get-caller-identity --query Account --output text)"
operator_cidr="${SSH_CIDR:-$(curl --fail --silent https://checkip.amazonaws.com)/32}"

if ! aws_cli budgets describe-budget --account-id "$account_id" --budget-name five-days-monthly >/dev/null 2>&1; then
  budget_file="$(mktemp)"
  notifications_file="$(mktemp)"
  jq -n '{
    BudgetName:"five-days-monthly",
    BudgetLimit:{Amount:"20",Unit:"USD"},
    TimeUnit:"MONTHLY",
    BudgetType:"COST"
  }' > "$budget_file"
  jq -n --arg email "$BILLING_ALERT_EMAIL" '[5,10,20] | map({
    Notification:{NotificationType:"ACTUAL",ComparisonOperator:"GREATER_THAN",Threshold:.,ThresholdType:"ABSOLUTE_VALUE"},
    Subscribers:[{SubscriptionType:"EMAIL",Address:$email}]
  })' > "$notifications_file"
  aws_cli budgets create-budget \
    --account-id "$account_id" \
    --budget "file://$budget_file" \
    --notifications-with-subscribers "file://$notifications_file"
  find "$budget_file" "$notifications_file" -delete
fi

install -d -m 0700 "$SECRET_DIR"
if ! aws_cli lightsail get-key-pair --key-pair-name "$KEY_PAIR_NAME" >/dev/null 2>&1; then
  umask 077
  aws_cli lightsail create-key-pair \
    --key-pair-name "$KEY_PAIR_NAME" \
    --query privateKeyBase64 \
    --output text > "$SSH_KEY_FILE"
  chmod 0600 "$SSH_KEY_FILE"
fi
[ -f "$SSH_KEY_FILE" ] || {
  echo "Lightsail key pair exists, but its local private key is missing: $SSH_KEY_FILE" >&2
  exit 1
}

if ! aws_cli lightsail get-instance --instance-name "$INSTANCE_NAME" >/dev/null 2>&1; then
  user_data_file="$(mktemp)"
  public_key="$(ssh-keygen -y -f "$SSH_KEY_FILE")"
  sed "s|__DEPLOY_PUBLIC_KEY__|$public_key|" "$PROJECT_ROOT/deploy/aws/lightsail-user-data.sh" > "$user_data_file"
  aws_cli lightsail create-instances \
    --instance-names "$INSTANCE_NAME" \
    --availability-zone "${AWS_REGION_NAME}a" \
    --blueprint-id "$BLUEPRINT_ID" \
    --bundle-id "$BUNDLE_ID" \
    --key-pair-name "$KEY_PAIR_NAME" \
    --ip-address-type dualstack \
    --user-data "file://$user_data_file" \
    --tags key=project,value=five-days key=environment,value=staging >/dev/null
  find "$user_data_file" -delete
fi

for ((attempt = 1; attempt <= 60; attempt += 1)); do
  state="$(aws_cli lightsail get-instance --instance-name "$INSTANCE_NAME" --query 'instance.state.name' --output text)"
  [ "$state" = running ] && break
  sleep 5
done
[ "${state:-}" = running ] || { echo "Lightsail instance did not reach running state." >&2; exit 1; }

if ! aws_cli lightsail get-static-ip --static-ip-name "$STATIC_IP_NAME" >/dev/null 2>&1; then
  aws_cli lightsail allocate-static-ip --static-ip-name "$STATIC_IP_NAME" >/dev/null
fi
attached_instance="$(aws_cli lightsail get-static-ip --static-ip-name "$STATIC_IP_NAME" --query 'staticIp.attachedTo' --output text)"
if [ "$attached_instance" != "$INSTANCE_NAME" ]; then
  aws_cli lightsail attach-static-ip --static-ip-name "$STATIC_IP_NAME" --instance-name "$INSTANCE_NAME" >/dev/null
fi

port_info_file="$(mktemp)"
jq -n --arg operator "$operator_cidr" '[
  {fromPort:22,toPort:22,protocol:"TCP",cidrs:[$operator]},
  {fromPort:80,toPort:80,protocol:"TCP",cidrs:["0.0.0.0/0"],ipv6Cidrs:["::/0"]},
  {fromPort:443,toPort:443,protocol:"TCP",cidrs:["0.0.0.0/0"],ipv6Cidrs:["::/0"]},
  {fromPort:443,toPort:443,protocol:"UDP",cidrs:["0.0.0.0/0"],ipv6Cidrs:["::/0"]}
]' > "$port_info_file"
aws_cli lightsail put-instance-public-ports \
  --instance-name "$INSTANCE_NAME" \
  --port-infos "file://$port_info_file" >/dev/null
find "$port_info_file" -delete

provider_arn="arn:aws:iam::$account_id:oidc-provider/token.actions.githubusercontent.com"
if ! aws_cli iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn" >/dev/null 2>&1; then
  aws_cli iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
fi

trust_file="$(mktemp)"
jq -n --arg provider "$provider_arn" --arg subject "$OIDC_SUBJECT" '{
  Version:"2012-10-17",
  Statement:[{
    Effect:"Allow",
    Principal:{Federated:$provider},
    Action:"sts:AssumeRoleWithWebIdentity",
    Condition:{
      StringEquals:{
        "token.actions.githubusercontent.com:aud":"sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub":$subject
      }
    }
  }]
}' > "$trust_file"
if ! aws_cli iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws_cli iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "file://$trust_file" >/dev/null
else
  aws_cli iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$trust_file"
fi
find "$trust_file" -delete

policy_file="$(mktemp)"
jq -n '{
  Version:"2012-10-17",
  Statement:[{
    Effect:"Allow",
    Action:[
      "lightsail:OpenInstancePublicPorts",
      "lightsail:CloseInstancePublicPorts",
      "lightsail:GetInstance",
      "lightsail:GetInstancePortStates"
    ],
    Resource:"*"
  }]
}' > "$policy_file"
aws_cli iam put-role-policy --role-name "$ROLE_NAME" --policy-name FiveDaysLightsailSshWindow --policy-document "file://$policy_file"
find "$policy_file" -delete

static_ip="$(aws_cli lightsail get-static-ip --static-ip-name "$STATIC_IP_NAME" --query 'staticIp.ipAddress' --output text)"
role_arn="$(aws_cli iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
jq -n \
  --arg instance "$INSTANCE_NAME" \
  --arg ip "$static_ip" \
  --arg roleArn "$role_arn" \
  --arg keyFile "$SSH_KEY_FILE" \
  --arg webHost "five-days-web.duckdns.org" \
  --arg gameHost "five-days-game.duckdns.org" \
  '{instance:$instance,staticIp:$ip,roleArn:$roleArn,sshPrivateKey:$keyFile,webHost:$webHost,gameHost:$gameHost}'
