# Manual deployment with the AWS CLI

This guide deploys the Arlo frontend, backend, and RTMS containers to an
existing single EC2 host without opening SSH. It uses ECR for images, Systems
Manager Parameter Store for secrets, KMS for parameter encryption, and Systems
Manager Run Command for host installation and updates.

It does not provision the VPC, EC2 instance, ALB, CloudFront distribution, or
Aurora cluster. Provision those resources first. The EC2 instance requires:

- Linux x86_64, Docker Engine, Docker Compose v2, AWS CLI v2, and the SSM Agent.
- An instance profile that permits ECR pulls, `ssm:GetParameter` under the
  selected parameter prefix, and `kms:Decrypt` for the parameter KMS key.
- Outbound HTTPS access to AWS, Zoom, and OpenRouter.
- Network access to the Aurora MySQL writer endpoint on port 3306.
- Inbound ports 3000-3001 only from the ALB security group. Do not open SSH.

The database schema must already exist. Application startup intentionally does
not run `prisma db push`.

## 1. Configure AWS credentials

AWS IAM Identity Center (SSO) is recommended for an operator workstation:

```bash
aws configure sso --profile arlo-deployer
aws sso login --profile arlo-deployer
export AWS_PROFILE=arlo-deployer
```

If the organization issues access keys instead, configure a named profile. Do
not put access keys in this repository or any Arlo `.env` file:

```bash
aws configure --profile arlo-deployer
export AWS_PROFILE=arlo-deployer
```

The operator identity needs ECR repository and image write access, SSM
parameter write access, KMS encrypt access, `ssm:SendCommand`,
`ssm:GetCommandInvocation`, and read access for EC2/ECR/SSM discovery. Verify
the selected account before continuing:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws sts get-caller-identity
```

## 2. Set deployment variables

Run these commands from a clone of the `ec2-main-deployment` branch:

```bash
git clone --branch ec2-main-deployment https://github.com/zoom/arlo.git
cd arlo

export INSTANCE_ID=i-REPLACE_ME
export PUBLIC_URL=https://REPLACE_ME
export PARAMETER_PREFIX=/arlo/prod
export KMS_KEY_ID=alias/arlo-prod
export IMAGE_TAG="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)"
export ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
```

`PUBLIC_URL` is the externally visible CloudFront or custom-domain URL, without
a trailing slash. Configure Zoom Marketplace with matching values:

- Home URL: `${PUBLIC_URL}/`
- OAuth redirect URL: `${PUBLIC_URL}/api/auth/callback`
- Webhook endpoint: `${PUBLIC_URL}/api/rtms/webhook`

## 3. Prepare the deployment environment

The production host does not use a plaintext secret `.env` file. Use a local
`.env.deploy` only to stage values before uploading them to encrypted SSM
parameters:

```bash
cp deploy/ec2/.env.deploy.example .env.deploy
chmod 600 .env.deploy
```

Edit `.env.deploy`. Use the Aurora cluster endpoint and a least-privilege
database account, not the Aurora master account. Generate independent secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

The file is ignored by Git. Confirm that no placeholders remain, then load it
into the current shell:

```bash
if grep -q 'REPLACE_' .env.deploy; then
  echo 'Replace every required placeholder in .env.deploy' >&2
  exit 1
fi

set -a
source ./.env.deploy
set +a
```

Use single quotes around values in `.env.deploy`. Percent-encode reserved
characters in the database password before putting it in `DATABASE_URL`.

## 4. Create or verify the KMS key

Reuse an existing customer-managed key when available:

```bash
aws kms describe-key --key-id "$KMS_KEY_ID" \
  --query 'KeyMetadata.[KeyId,KeyState]' --output table
```

For a new account, an authorized administrator can create the key and alias:

```bash
KEY_ID="$(aws kms create-key \
  --description 'Arlo production parameter encryption' \
  --tags TagKey=Group,TagValue=arlo-assistant \
  --query KeyMetadata.KeyId --output text)"
aws kms create-alias --alias-name alias/arlo-prod --target-key-id "$KEY_ID"
export KMS_KEY_ID=alias/arlo-prod
```

Review the key policy and grant only the EC2 instance role `kms:Decrypt`. The
operator role needs encryption and parameter-management permissions but should
not be used by the application containers.

### KMS access model

KMS does not store the database URL, Zoom secrets, or OpenRouter key. Parameter
Store holds their encrypted values. KMS holds a non-exportable encryption key
and performs cryptographic operations after IAM and key-policy authorization.
No user, container, or administrator can download the plaintext KMS key.

Use these access boundaries:

- Deployment operators need `kms:Encrypt` and `kms:DescribeKey` to create or
  update parameters. They do not need `kms:Decrypt` for routine deployments.
- The EC2 instance role needs `kms:Decrypt` and `ssm:GetParameter` only for
  `${PARAMETER_PREFIX}/*` so `start.sh` can resolve runtime secrets.
- The application containers receive only the resolved environment variables.
  Do not attach AWS credentials or a separate IAM role to the containers.
- Do not grant broad `kms:*`, `ssm:GetParameter*`, or administrator policies to
  application identities. Retain a separately audited break-glass role if
  plaintext retrieval is operationally required.

Restrict the KMS decrypt permission with the Parameter Store encryption
context as well as the key ARN. The instance-role condition should follow this
pattern, with the account, region, and key ARN replaced:

```json
{
  "Effect": "Allow",
  "Action": "kms:Decrypt",
  "Resource": "arn:aws:kms:us-east-1:ACCOUNT_ID:key/KEY_ID",
  "Condition": {
    "StringLike": {
      "kms:EncryptionContext:PARAMETER_ARN":
        "arn:aws:ssm:us-east-1:ACCOUNT_ID:parameter/arlo/prod/*"
    }
  }
}
```

Docker bridge networks can otherwise attempt to reach the EC2 Instance
Metadata Service and obtain the host role. Require IMDSv2 and set the response
hop limit to one so host services continue to work but ordinary bridged
containers cannot retrieve instance-role credentials:

```bash
aws ec2 modify-instance-metadata-options \
  --instance-id "$INSTANCE_ID" \
  --http-endpoint enabled \
  --http-tokens required \
  --http-put-response-hop-limit 1
```

Root on the EC2 host can inspect container environment variables and can use
the instance role. Limit SSM session and Run Command access to trusted
operators; KMS encryption does not protect against a fully compromised host.

To confirm a deployment role has metadata/encryption access without exposing a
secret, use `describe-key` and inspect grants. Do not add `--with-decryption`
during routine verification:

```bash
aws kms describe-key --key-id "$KMS_KEY_ID" \
  --query 'KeyMetadata.[KeyId,KeyState]' --output table
aws kms list-grants --key-id "$KMS_KEY_ID" \
  --query 'Grants[].{Grantee:GranteePrincipal,Operations:Operations}'
```

### Reuse an existing parameter set

For an update to an existing deployment, do not create `.env.deploy` and do
not run the upload commands unless a secret actually needs changing. List the
existing parameter metadata without decrypting values:

```bash
aws ssm describe-parameters \
  --parameter-filters \
    "Key=Path,Option=Recursive,Values=${PARAMETER_PREFIX}" \
  --query 'Parameters[].{Name:Name,Type:Type,KeyId:KeyId,Version:Version,Modified:LastModifiedDate}' \
  --output table
```

Confirm these required names exist under the selected prefix:

- `database-url`
- `zoom-client-id`
- `zoom-client-secret`
- `zoom-webhook-secret-token`
- `session-secret`
- `token-encryption-key`, or legacy `redis-encryption-key`

`openrouter-api-key` is optional. If the required parameters exist, continue
at ECR image creation/build and set the same `PARAMETER_PREFIX` in
`/etc/arlo/images.env`. At startup, EC2 retrieves the existing values; image
updates do not overwrite them.

To rotate one existing value, use the upload function in the next section only
for that parameter. `--overwrite` creates a new SSM parameter version. Verify
the application after rotation before changing any other secret. Avoid commands
that print decrypted values to a terminal, log, ticket, or shell transcript.

## 5. Upload secrets to Parameter Store

The following function updates KMS-encrypted `SecureString` parameters. AWS CLI
arguments are not written to shell history because the values come from shell
variables, but avoid running this on a shared workstation:

```bash
put_secure_parameter() {
  local name="$1"
  local value="$2"
  aws ssm put-parameter \
    --name "${PARAMETER_PREFIX}/${name}" \
    --type SecureString \
    --key-id "$KMS_KEY_ID" \
    --value "$value" \
    --overwrite >/dev/null
  printf 'Updated %s/%s\n' "$PARAMETER_PREFIX" "$name"
}

put_secure_parameter database-url "$DATABASE_URL"
put_secure_parameter zoom-client-id "$ZOOM_CLIENT_ID"
put_secure_parameter zoom-client-secret "$ZOOM_CLIENT_SECRET"
put_secure_parameter zoom-webhook-secret-token "$ZOOM_WEBHOOK_TOKEN"
put_secure_parameter session-secret "$SESSION_SECRET"
put_secure_parameter token-encryption-key "$TOKEN_ENCRYPTION_KEY"

if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  put_secure_parameter openrouter-api-key "$OPENROUTER_API_KEY"
fi
```

Clear the loaded values when the upload finishes:

```bash
unset DATABASE_URL ZOOM_CLIENT_ID ZOOM_CLIENT_SECRET ZOOM_WEBHOOK_TOKEN
unset SESSION_SECRET TOKEN_ENCRYPTION_KEY OPENROUTER_API_KEY
```

Keep `.env.deploy` only in an approved secrets location, or delete the local
staging copy after confirming the SSM parameter versions.

## 6. Create ECR repositories

```bash
for repository in arlo-frontend arlo-backend arlo-rtms; do
  aws ecr describe-repositories --repository-names "$repository" >/dev/null 2>&1 ||
    aws ecr create-repository \
      --repository-name "$repository" \
      --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 >/dev/null
done
```

Configure lifecycle policies separately according to the required rollback
retention. Never delete an image currently referenced by `/etc/arlo/images.env`.

## 7. Build and push immutable images

The current EC2 deployment is x86_64, so build for `linux/amd64`. Do not reuse
an existing tag:

```bash
DOCKER_CONFIG="$(mktemp -d)"
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker buildx build --platform linux/amd64 --provenance=false \
  -t "${ECR_REGISTRY}/arlo-frontend:${IMAGE_TAG}" --push frontend
docker buildx build --platform linux/amd64 --provenance=false \
  -t "${ECR_REGISTRY}/arlo-backend:${IMAGE_TAG}" --push backend
docker buildx build --platform linux/amd64 --provenance=false \
  -t "${ECR_REGISTRY}/arlo-rtms:${IMAGE_TAG}" --push rtms

rm -rf "$DOCKER_CONFIG"
trap - EXIT
unset DOCKER_CONFIG
```

Confirm all three tags exist before updating EC2:

```bash
for repository in arlo-frontend arlo-backend arlo-rtms; do
  aws ecr describe-images --repository-name "$repository" \
    --image-ids imageTag="$IMAGE_TAG" \
    --query 'imageDetails[0].[imageDigest,imagePushedAt]' --output table
done
```

For a completely empty Aurora database, initialize the schema as a separate,
reviewed deployment operation before starting Arlo. The repository does not
contain a production migration history, so coordinate this step with the DBA
and run `npx prisma db push --skip-generate` from the newly built backend image.
Do not run it automatically on every restart. Skip this operation when using an
existing Arlo database.

## 8. Install or update the EC2 service through SSM

Create the non-secret host environment file locally. This is the only
environment file copied to EC2:

```bash
cat > /tmp/arlo-images.env <<EOF
FRONTEND_IMAGE=${ECR_REGISTRY}/arlo-frontend:${IMAGE_TAG}
BACKEND_IMAGE=${ECR_REGISTRY}/arlo-backend:${IMAGE_TAG}
RTMS_IMAGE=${ECR_REGISTRY}/arlo-rtms:${IMAGE_TAG}
AWS_REGION=${AWS_REGION}
PARAMETER_PREFIX=${PARAMETER_PREFIX}
PUBLIC_URL=${PUBLIC_URL}
OPENROUTER_MODELS=z-ai/glm-5.2:free,google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free
DEFAULT_MODEL=z-ai/glm-5.2:free
FALLBACK_MODEL=google/gemma-4-31b-it:free
EOF
chmod 600 /tmp/arlo-images.env
```

Encode the four host files and create an SSM command document. `jq` and GNU
`base64` are required on the operator workstation:

```bash
COMPOSE_B64="$(base64 -w0 deploy/ec2/docker-compose.yml)"
START_B64="$(base64 -w0 deploy/ec2/start.sh)"
SERVICE_B64="$(base64 -w0 deploy/ec2/arlo.service)"
ENV_B64="$(base64 -w0 /tmp/arlo-images.env)"

jq -n \
  --arg compose "$COMPOSE_B64" \
  --arg start "$START_B64" \
  --arg service "$SERVICE_B64" \
  --arg env "$ENV_B64" \
  '{commands: [
    "set -euo pipefail",
    "command -v docker >/dev/null",
    "docker compose version >/dev/null",
    "command -v aws >/dev/null",
    "install -d -m 0750 /opt/arlo /etc/arlo",
    "test ! -f /etc/arlo/images.env || cp /etc/arlo/images.env /etc/arlo/images.env.previous",
    ("printf %s " + ($compose | @sh) + " | base64 -d > /opt/arlo/docker-compose.yml"),
    ("printf %s " + ($start | @sh) + " | base64 -d > /opt/arlo/start.sh"),
    ("printf %s " + ($service | @sh) + " | base64 -d > /etc/systemd/system/arlo.service"),
    ("printf %s " + ($env | @sh) + " | base64 -d > /etc/arlo/images.env"),
    "chmod 0750 /opt/arlo/start.sh",
    "chmod 0600 /etc/arlo/images.env",
    "systemctl daemon-reload",
    "systemctl enable arlo",
    "systemctl restart arlo"
  ]}' > /tmp/arlo-install-command.json

COMMAND_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Deploy Arlo ${IMAGE_TAG}" \
  --parameters file:///tmp/arlo-install-command.json \
  --query Command.CommandId --output text)"

aws ssm wait command-executed \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID"
aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}'
```

The same procedure performs an update. It writes immutable image tags, backs
up the previous image environment, pulls images in `start.sh`, and restarts the
Compose stack. It does not alter Aurora data or run schema changes.

## 9. Verify the deployment

```bash
curl --fail --show-error --silent "${PUBLIC_URL}/health"

VERIFY_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl is-active arlo","docker compose -f /opt/arlo/docker-compose.yml ps","curl -fsS http://127.0.0.1:3000/health"]' \
  --query Command.CommandId --output text)"

aws ssm wait command-executed \
  --command-id "$VERIFY_ID" --instance-id "$INSTANCE_ID"
aws ssm get-command-invocation \
  --command-id "$VERIFY_ID" --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}'
```

Also verify the ALB target groups are healthy and complete a Zoom OAuth and
RTMS test. A health endpoint alone does not prove Zoom media connectivity.

## 10. Roll back

The installation command preserves the previous image file. Roll back without
SSH:

```bash
ROLLBACK_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["set -euo pipefail","test -f /etc/arlo/images.env.previous","cp /etc/arlo/images.env.previous /etc/arlo/images.env","chmod 0600 /etc/arlo/images.env","systemctl restart arlo"]' \
  --query Command.CommandId --output text)"

aws ssm wait command-executed \
  --command-id "$ROLLBACK_ID" --instance-id "$INSTANCE_ID"
aws ssm get-command-invocation \
  --command-id "$ROLLBACK_ID" --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}'
```

Do not remove old ECR images until the new deployment and rollback path have
been validated.
