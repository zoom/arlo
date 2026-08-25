# Single-host AWS EC2 deployment

This deployment runs the frontend, backend, and RTMS services on one private
x86 EC2 instance. CloudFront and the existing ALB remain the public entrypoint.
Aurora MySQL is external to the Compose stack.

## Required SSM parameters

All sensitive parameters are `SecureString` values encrypted with
`alias/arlo-prod`:

- `/arlo/prod/aurora-database-url`
- `/arlo/prod/zoom-client-id`
- `/arlo/prod/zoom-client-secret`
- `/arlo/prod/zoom-webhook-secret-token`
- `/arlo/prod/session-secret`
- `/arlo/prod/redis-encryption-key`
- `/arlo/prod/openrouter-api-key`

The Aurora parameter must contain the least-privilege application connection
string, not the cluster master credential. The service refuses to start when
that parameter is absent.

## Host files

Install these files with root ownership:

- `docker-compose.yml` -> `/opt/arlo/docker-compose.yml`
- `start.sh` -> `/opt/arlo/start.sh` with mode `0750`
- `arlo.service` -> `/etc/systemd/system/arlo.service`

Create `/etc/arlo/images.env` with mode `0600` containing immutable ECR image
references:

```dotenv
FRONTEND_IMAGE=ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/arlo-frontend:TAG
BACKEND_IMAGE=ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/arlo-backend:TAG
RTMS_IMAGE=ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/arlo-rtms:TAG
```

Then run `systemctl daemon-reload` and `systemctl enable --now arlo`.

Do not run `prisma db push` during application startup. Apply a reviewed schema
migration to Aurora before starting the backend.
