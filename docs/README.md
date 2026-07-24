# Arlo Documentation

This directory contains documentation specific to the Arlo Meeting Assistant
reference implementation.

## Start Here

| Document | Use it for |
| --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Current local/AWS components, data flow, security, and WebSocket contract |
| [`FRESH_INSTALL_CHECKLIST.md`](./FRESH_INSTALL_CHECKLIST.md) | Fresh local Docker Compose verification |
| [`MYSQL_MIGRATION.md`](./MYSQL_MIGRATION.md) | MySQL setup and legacy PostgreSQL cutover notes |
| [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) | Implemented features, limitations, and next actions |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | Local development and Zoom App troubleshooting |
| [`figma-prompt-guest-mode.md`](./figma-prompt-guest-mode.md) | Design-only guest-mode UI brief |

## Deployment Guides

- Local quick start: [`../README.md`](../README.md)
- AWS scalable Terraform: [`../deploy/aws/terraform/README.md`](../deploy/aws/terraform/README.md)
- Self-hosted VM: [`../deploy/selfhost/README.md`](../deploy/selfhost/README.md)
- Deployment overview: [`../deploy/README.md`](../deploy/README.md)

## Reusable Zoom Guidance

The repository also contains reusable Zoom Apps guidance under
[`../.claude/skills/zoom-apps/`](../.claude/skills/zoom-apps/). Those files are
general SDK guidance, not a substitute for the current Arlo architecture or
deployment instructions.

The current source of truth for SDK capabilities is
[`frontend/src/contexts/ZoomSdkContext.js`](../frontend/src/contexts/ZoomSdkContext.js).
