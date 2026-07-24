# MySQL Deployment and Legacy PostgreSQL Cutover

The current Prisma schema uses MySQL 8.0. This document is only needed when
moving data from an older PostgreSQL deployment or when connecting Arlo to an
existing Amazon RDS MySQL instance. The repository's current Terraform stack
does not provision PostgreSQL.

## Current MySQL Contract

- Prisma provider: `mysql`
- Recommended engine: MySQL 8.0
- RDS should be private (`publicly_accessible = false`)
- Security-group ingress should allow the backend ECS task security group
  only, plus the RTMS worker security group if the worker writes directly to
  MySQL in the selected deployment
- AWS Terraform can create a private RDS MySQL instance and write its
  `DATABASE_URL` to a KMS-backed SSM SecureString
- For an existing remote database, write the connection string to the correct
  SSM parameter, for example `/arlo/prod/database-url`, and ensure VPC routing,
  security groups, DNS, and port 3306 access are configured

The backend and RTMS persistence path both use `DATABASE_URL`. The backend
owns the main meeting/transcript writes; RTMS sends normalized events to the
backend and may publish realtime events directly to Valkey.

## New MySQL Database

Create the database and apply the current Prisma schema in a staging or
maintenance environment first:

```bash
cd backend
export DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/meeting_assistant'
npx prisma generate
npx prisma db push
```

`prisma db push` is used by the current development/bootstrap flow because this
repository does not contain a checked-in Prisma migrations directory. Do not
run it blindly against a production database; take a backup and review the
schema change before applying it.

## Legacy PostgreSQL Source

If the source deployment is PostgreSQL:

1. Take and verify a PostgreSQL backup.
2. Create an isolated MySQL target and apply the current schema.
3. Use AWS Database Migration Service or a controlled ETL job to copy rows.
4. Map PostgreSQL arrays such as token scopes and highlight tags to MySQL JSON
   arrays. Map JSONB values to MySQL JSON.
5. Preserve UUIDs, owner relationships, transcript sequence numbers, and
   millisecond timestamp values. Check that encrypted OAuth token ciphertext is
   copied without transformation.
6. Compare row counts and representative records for users, meetings, speakers,
   transcript segments, participant events, highlights, summaries, AI messages,
   citations, and user tokens.
7. Exercise OAuth, meeting lookup, transcript retrieval, search, summary,
   highlights, WebVTT export, and RTMS persistence against the MySQL target.
8. Stop or drain writes to the old deployment, complete the final load, update
   the MySQL `DATABASE_URL`, and restart/redeploy every service that reads it.
9. Keep the PostgreSQL source available until rollback and restore tests pass.
10. Decommission the old source only after the retention and rollback window.

Do not point the MySQL Prisma schema at the old PostgreSQL server. Prisma
schema providers are not interchangeable.

## AWS SSM Cutover

For the Terraform deployment, update the KMS-backed SSM parameter without
putting the connection string in Terraform variables or state:

```bash
export AWS_REGION=us-east-1
export SSM_PREFIX=/arlo/prod
export KMS_KEY_ID=alias/arlo-prod
export DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/meeting_assistant'
export ZOOM_CLIENT_ID='...'
export ZOOM_CLIENT_SECRET='...'
export ZOOM_WEBHOOK_SECRET_TOKEN='...'
export SESSION_SECRET="$(openssl rand -hex 32)"
export REDIS_ENCRYPTION_KEY="$(openssl rand -hex 16)"
export INTERNAL_WEBHOOK_SECRET="$(openssl rand -hex 32)"
./deploy/aws/terraform/put-secrets.sh
```

Run this from the repository root, or use the script path from inside
`deploy/aws/terraform`. After changing a secret, force a new ECS deployment so
new tasks fetch the updated SSM value.

## Verification

```bash
cd backend
DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/meeting_assistant' npx prisma generate
DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/meeting_assistant' npx prisma db push
npm test
```

The current application does not perform automatic deletion of MySQL meeting
history when RTMS stops. Valkey and DynamoDB control records are ephemeral;
MySQL data requires an explicit retention or deletion policy.
