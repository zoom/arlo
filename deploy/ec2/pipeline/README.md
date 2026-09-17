# EC2 Pull CI/CD Pipeline

This pipeline checks the public `ec2-main-deployment` branch every day at
09:00 Singapore time. A changed commit is tested, built into three immutable
container images, pushed to ECR, and deployed automatically to the existing
EC2 host through Systems Manager. No inbound SSH or GitHub organization
integration is required.

Runtime secrets are not available to CodeBuild. The EC2 service continues to
load the existing `/arlo/prod/*` SecureString parameters through its instance
role, with KMS decryption constrained to Parameter Store. The pipeline only
creates a non-secret `images.env` containing image references and public
runtime settings.

## Flow

1. EventBridge Scheduler starts the checker CodeBuild project.
2. The checker compares GitHub's branch SHA with `/arlo/cicd/deployed-commit`.
3. For a new SHA, it uploads an exact source archive to versioned S3 and starts
   CodePipeline with that S3 object version.
4. The build job runs the encryption test, builds `linux/amd64` images, pushes
   immutable `release-<full-sha>` tags, and publishes a checksummed release
   bundle.
5. The deploy job invokes a custom SSM document on EC2. The host pre-pulls all
   images, updates the service, runs local and public health checks, and rolls
   back all deployment files if a check fails.
6. The deployed SHA is recorded only after successful health checks.

CloudWatch logging is disabled for all three CodeBuild projects. Encrypted S3
logs and release bundles expire after 30 days. ECR retains the three newest
tagged images per repository and expires untagged artifacts after one day.

## Deploy Infrastructure

Create the Terraform state bucket once:

```bash
export AWS_PROFILE=889455048101_devreldemos_admin_role
export AWS_REGION=us-east-1
STATE_BUCKET=arlo-cicd-state-889455048101-us-east-1

aws s3api create-bucket --bucket "$STATE_BUCKET" --region "$AWS_REGION"
aws s3api put-public-access-block --bucket "$STATE_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$STATE_BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$STATE_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

Initialize and apply:

```bash
cd deploy/ec2/pipeline/terraform
terraform init \
  -backend-config="bucket=arlo-cicd-state-889455048101-us-east-1" \
  -backend-config="key=arlo/ec2-cicd.tfstate" \
  -backend-config="region=us-east-1" \
  -backend-config="profile=889455048101_devreldemos_admin_role" \
  -backend-config="encrypt=true" \
  -backend-config="use_lockfile=true"
terraform plan -out=arlo-cicd.tfplan
terraform apply arlo-cicd.tfplan
```

The default variables target the current production host. Override them with
CLI `-var` options or an untracked `.tfvars` file when deploying elsewhere.

## Operate

Run an immediate check and automatic release:

```bash
aws codebuild start-build --region us-east-1 \
  --project-name arlo-ec2-cicd-checker
```

Validate GitHub access and commit detection without uploading or deploying:

```bash
aws codebuild start-build --region us-east-1 \
  --project-name arlo-ec2-cicd-checker \
  --environment-variables-override name=DRY_RUN,value=true,type=PLAINTEXT
```

Inspect pipeline state:

```bash
aws codepipeline get-pipeline-state --region us-east-1 \
  --name arlo-ec2-cicd-release
aws ssm get-parameter --region us-east-1 \
  --name /arlo/cicd/deployed-commit --query Parameter.Value --output text
```

To stop automatic checks without deleting the pipeline:

```bash
aws scheduler update-schedule --region us-east-1 \
  --name arlo-ec2-cicd-daily --state DISABLED \
  --schedule-expression 'cron(0 9 * * ? *)' \
  --schedule-expression-timezone Asia/Singapore \
  --flexible-time-window Mode=OFF \
  --target file://scheduler-target.json
```

Prefer changing `state` in Terraform and applying it; the CLI form requires
the existing complete target document in `scheduler-target.json`.
