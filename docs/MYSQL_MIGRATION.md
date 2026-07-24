# PostgreSQL to Amazon RDS MySQL Migration

The application branch is prepared for MySQL 8.0. The migration must be run as
a parallel database cutover; do not change the live `DATABASE_URL` until the
new database has been loaded and verified.

## Target

- Amazon RDS MySQL 8.0.46 in the existing private database subnets
- Storage encryption with the Arlo KMS key
- `publicly_accessible = false`
- Security-group ingress only from the backend ECS service
- Automated backups and deletion protection enabled for production
- ECS receives `DATABASE_URL` from the KMS-backed SSM SecureString parameter

## Migration Sequence

1. Take and verify a backup of the current RDS PostgreSQL database.
2. Create the new RDS MySQL instance with a separate identifier and, ideally,
   a separate Terraform workspace/state. The current Terraform state may still
   contain the PostgreSQL resource; changing that resource in place can cause a
   destructive replacement.
3. Apply the Prisma schema to the empty MySQL database:

   ```bash
   DATABASE_URL='mysql://arlo:...@new-host:3306/meeting_assistant' \
     npx prisma db push --schema backend/prisma/schema.prisma
   ```

4. Transfer data from PostgreSQL to MySQL. For production data, use AWS DMS or
   an equivalent controlled ETL process. The PostgreSQL array columns
   `user_tokens.scopes` and `highlights.tags` must be converted to JSON arrays.
5. Compare table row counts and sample records, especially meetings,
   transcript segments, participants, summaries, OAuth-token records, and
   highlights. Validate that timestamps, `BigInt` millisecond fields, JSON, and
   encrypted token values are preserved.
6. Run the application against MySQL in a staging ECS service and exercise
   OAuth, meeting lookup, transcript retrieval, search, summaries, highlights,
   and RTMS persistence.
7. At cutover, briefly stop writes to the old application, perform the final
   replication/load, update the SSM `database-url` value, and force a new ECS
   deployment so tasks receive the new secret value.
8. Keep PostgreSQL intact during the rollback window. Roll back by restoring
   the old SSM value and redeploying ECS if validation fails.
9. Only after the retention period and a successful restore test should the old
   PostgreSQL instance be decommissioned.

## Important Compatibility Changes

- Prisma now uses the `mysql` provider.
- PostgreSQL scalar arrays are represented as JSON arrays.
- Search no longer uses PostgreSQL JSONB or `to_tsvector` functions. The first
  MySQL implementation uses `LIKE`; add and benchmark a MySQL `FULLTEXT`
  index after cutover if transcript search volume requires it.

## Verification Commands

```bash
cd backend
npx prisma generate
npx prisma db push
npm test
```

Do not run `prisma db push` against the old PostgreSQL database after switching
the schema provider. Keep the old application image and PostgreSQL connection
available until the cutover is complete.
