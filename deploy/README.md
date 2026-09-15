# Deploy Scaffolding

This folder contains first-cut deployment scaffolding for Arlo across:

- AWS
- Self-hosted Docker Compose

## Scope

This first cut focuses on low-ops container hosting with native provider FQDNs.

Common assumptions:

- Container images already exist in a registry. Terraform does not build or push them.
- You will provide Zoom credentials and secrets through an env file or AWS SSM.
- The templates do not add Log Analytics, ELK, Kibana, or blob/object storage.
- No object storage is used in this version. Local/self-hosted logs remain in the container runtime unless you configure log shipping.

Provider-specific database behavior:

- AWS Terraform creates encrypted private RDS MySQL by default, or can consume a remote MySQL URL through SSM.
- Self-hosted Compose creates a local MySQL 8.0 container by default.
- The legacy AWS App Runner script and CloudFormation template expect an existing MySQL URL.

## Current Runtime Shape

The local/self-hosted runtime runs as three application services:

- `backend`
- `frontend`
- `rtms`

The backend proxies non-API traffic to the frontend service. To support managed
deployments, the proxy target is configurable with `FRONTEND_UPSTREAM_URL`.

The scalable AWS runtime adds an always-on `rtms-control` service and launches
one short-lived `rtms-worker` ECS task per active RTMS stream.

## Layout

```text
deploy/
├── README.md
├── common/
│   ├── arlo.deploy.env.example
│   ├── generate-secrets.sh
│   └── lib.sh
├── aws/
│   ├── README.md
│   ├── cloudformation.yml
│   ├── deploy.sh
│   └── terraform/
└── selfhost/
    ├── README.md
    ├── deploy.sh
    ├── docker-compose.prod.yml
    ├── nginx.conf.template
    └── setup.sh
```

## Shared Setup

1. Copy the common template:

   ```bash
   cp deploy/common/arlo.deploy.env.example deploy/common/arlo.deploy.env
   ```

2. Generate candidate secrets:

   ```bash
   deploy/common/generate-secrets.sh
   ```

The script prints shell assignments; it does not modify the env file. Copy the
output into the file, then fill in:

- `DATABASE_URL`
- `ZOOM_CLIENT_ID`
- `ZOOM_CLIENT_SECRET`
- `SESSION_SECRET`
- `REDIS_ENCRYPTION_KEY`
- image references
- cloud-specific variables

## Usage

The provider templates are the deployment entrypoints:

- AWS: `deploy/aws/terraform` for the scalable ECS/Fargate deployment.
- AWS quick start: `deploy/aws/cloudformation.yml` for a CloudFormation Launch Stack link. This is a simpler legacy scaffold, not the scalable RTMS worker architecture.
- Self-host: `deploy/selfhost/setup.sh` on a Debian/Ubuntu VM.

The scripts remain useful for CLI-driven deployments. Each script takes the env
file path as its first argument.

Examples:

```bash
deploy/aws/deploy.sh deploy/common/arlo.deploy.env
deploy/selfhost/deploy.sh deploy/common/arlo.deploy.env
```

## First-Cut Limitations

- The AWS Terraform template provisions encrypted private RDS MySQL 8.0 by default, or consumes an existing remote MySQL URL.
- The AWS CloudFormation path is simpler than the Terraform path and is intended
  as a quick-start scaffold.
- The local/self-hosted path runs frontend, backend, and RTMS as separate services. AWS also separates RTMS control from per-stream worker tasks.
- The Terraform path uses KMS-backed SSM parameters for runtime secrets.
