# Deploy Scaffolding

This folder contains first-cut deployment scaffolding for Arlo across:

- AWS
- Self-hosted Docker Compose

## Scope

This first cut focuses on low-ops container hosting with native provider FQDNs.

Assumptions:

- Container images already exist in a registry.
- A MySQL 8.0 database already exists and you have a valid `DATABASE_URL`.
- You will provide Zoom credentials and secrets via an env file.
- The templates do not add Log Analytics, ELK, Kibana, or blob/object storage.
- No object storage is used in this version.

## Current Runtime Shape

Arlo still runs as three app services:

- `backend`
- `frontend`
- `rtms`

The backend proxies non-API traffic to the frontend service. To support managed
deployments, the proxy target is now configurable with `FRONTEND_UPSTREAM_URL`.

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

2. Generate secrets:

   ```bash
   deploy/common/generate-secrets.sh
   ```

3. Fill in:

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
- AWS quick start: `deploy/aws/cloudformation.yml` for a CloudFormation Launch Stack link.
- Self-host: `deploy/selfhost/setup.sh` on a Debian/Ubuntu VM.

The scripts remain useful for CLI-driven deployments. Each script takes the env
file path as its first argument.

Examples:

```bash
deploy/aws/deploy.sh deploy/common/arlo.deploy.env
deploy/selfhost/deploy.sh deploy/common/arlo.deploy.env
```

## First-Cut Limitations

- The AWS Terraform template provisions encrypted private RDS MySQL 8.0 when enabled.
- The AWS CloudFormation path is simpler than the Terraform path and is intended
  as a quick-start scaffold.
- Frontend and RTMS are deployed as separate services rather than being folded
  into a single production image yet.
- The Terraform path uses KMS-backed SSM parameters for runtime secrets.
