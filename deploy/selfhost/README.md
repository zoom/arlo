# Self-Hosted First Cut

Target runtime:

- Docker Compose
- Local MySQL 8.0 container
- Existing backend, frontend, and RTMS images

Notes:

- This path keeps the current three-service app layout.
- `setup.sh` installs Docker, nginx, and certbot on Debian/Ubuntu.
- `nginx.conf.template` is the reverse proxy shape for the generated public FQDN.
- App data is persisted in MySQL only.

## VM Setup

From the repo root on a Debian/Ubuntu VM:

```bash
sudo deploy/selfhost/setup.sh
```

The script prompts for the FQDN and required secrets, writes `.env`, starts the
Compose stack, configures nginx, and optionally requests a Let's Encrypt cert.

## Compose-Only Setup

If you already have Docker and a reverse proxy:

```bash
cp deploy/common/arlo.deploy.env.example deploy/common/arlo.deploy.env
deploy/common/generate-secrets.sh
deploy/selfhost/deploy.sh deploy/common/arlo.deploy.env
```
