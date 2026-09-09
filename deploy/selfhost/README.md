# Self-Hosted First Cut

Target runtime:

- Docker Compose
- Local MySQL 8.0 container
- Existing backend, frontend, and RTMS images

Notes:

- This path keeps the current three-service app layout: MySQL, backend/frontend,
  and the RTMS service.
- `setup.sh` installs Docker, nginx, and certbot on Debian/Ubuntu and writes the
  repository-root `.env` file, not a file under `deploy/selfhost`.
- `nginx.conf.template` is the reverse proxy shape for the generated public FQDN.
- App data is persisted in MySQL only.

## VM Setup

From the repo root on a Debian/Ubuntu VM:

```bash
sudo deploy/selfhost/setup.sh
```

The script prompts for the FQDN and required secrets, writes the repository-root
`.env`, starts the root Compose stack with a generated VM override, configures
nginx, and optionally requests a Let's Encrypt certificate. It builds the local
Dockerfiles rather than pulling the prebuilt images used by `deploy.sh`.

## Compose-Only Setup

If you already have Docker and a reverse proxy:

```bash
cp deploy/common/arlo.deploy.env.example deploy/common/arlo.deploy.env
deploy/common/generate-secrets.sh
deploy/selfhost/deploy.sh deploy/common/arlo.deploy.env
```

`generate-secrets.sh` prints values but does not write the env file. The
Compose-only path requires `BACKEND_IMAGE`, `FRONTEND_IMAGE`, and `RTMS_IMAGE`
to refer to images accessible from the host, and exposes the backend, frontend,
and RTMS ports directly unless an external reverse proxy is configured.
