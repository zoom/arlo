#!/usr/bin/env bash

set -euo pipefail

if command -v node >/dev/null 2>&1; then
  node <<'EOF'
const crypto = require('crypto');
console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`);
console.log(`REDIS_ENCRYPTION_KEY=${crypto.randomBytes(16).toString('hex')}`);
EOF
  exit 0
fi

if command -v openssl >/dev/null 2>&1; then
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
  echo "REDIS_ENCRYPTION_KEY=$(openssl rand -hex 16)"
  exit 0
fi

echo "Install either node or openssl to generate secrets." >&2
exit 1
