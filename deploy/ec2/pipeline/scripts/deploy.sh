#!/usr/bin/env bash

set -euo pipefail

artifact_bucket='{{ ArtifactBucket }}'
artifact_key='{{ ArtifactKey }}'
expected_sha256='{{ ArtifactSha256 }}'
source_commit='{{ SourceCommit }}'
app_dir=/opt/arlo
env_dir=/etc/arlo
rollback_root=/var/lib/arlo/rollbacks
work_dir="$(mktemp -d /var/tmp/arlo-deploy.XXXXXX)"
backup_dir="${rollback_root}/$(date -u +%Y%m%dT%H%M%SZ)-${source_commit}"
lock_file=/var/lock/arlo-deploy.lock
rollback_required=false

cleanup() {
  rm -rf "$work_dir"
}

rollback() {
  local exit_code=$?
  if [[ "$rollback_required" == true ]]; then
    echo "Deployment failed; restoring the previous release"
    install -m 0644 "$backup_dir/docker-compose.yml" "$app_dir/docker-compose.yml"
    install -m 0755 "$backup_dir/start.sh" "$app_dir/start.sh"
    install -m 0644 "$backup_dir/arlo.service" /etc/systemd/system/arlo.service
    install -m 0600 "$backup_dir/images.env" "$env_dir/images.env"
    systemctl daemon-reload
    systemctl restart arlo.service || true
  fi
  cleanup
  exit "$exit_code"
}

trap rollback EXIT
exec 9>"$lock_file"
flock -n 9 || { echo "Another Arlo deployment is running"; exit 1; }

aws s3 cp "s3://${artifact_bucket}/${artifact_key}" "$work_dir/deployment.tar.gz" --only-show-errors
actual_sha256="$(sha256sum "$work_dir/deployment.tar.gz" | awk '{print $1}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || { echo "Release checksum mismatch"; exit 1; }

mkdir -p "$work_dir/release"
tar -C "$work_dir/release" -xzf "$work_dir/deployment.tar.gz"
for required_file in docker-compose.yml start.sh arlo.service arlo-journald.conf images.env; do
  [[ -f "$work_dir/release/$required_file" ]] || { echo "Release is missing $required_file"; exit 1; }
done

set -a
# The release environment contains image references and non-secret settings only.
source "$work_dir/release/images.env"
set +a
[[ "${SOURCE_COMMIT:-}" == "$source_commit" ]] || { echo "Release commit mismatch"; exit 1; }

docker_config="$(mktemp -d "$work_dir/docker-config.XXXXXX")"
export DOCKER_CONFIG="$docker_config"
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "${FRONTEND_IMAGE%%/*}" >/dev/null
docker pull "$FRONTEND_IMAGE"
docker pull "$BACKEND_IMAGE"
docker pull "$RTMS_IMAGE"
rm -rf "$docker_config"
unset DOCKER_CONFIG

mkdir -p "$app_dir" "$env_dir" "$rollback_root" "$backup_dir"
mkdir -p /etc/systemd/journald.conf.d
if ! cmp -s "$work_dir/release/arlo-journald.conf" /etc/systemd/journald.conf.d/arlo-retention.conf; then
  install -m 0644 "$work_dir/release/arlo-journald.conf" /etc/systemd/journald.conf.d/arlo-retention.conf
  systemctl restart systemd-journald
fi
install -m 0644 "$app_dir/docker-compose.yml" "$backup_dir/docker-compose.yml"
install -m 0755 "$app_dir/start.sh" "$backup_dir/start.sh"
install -m 0644 /etc/systemd/system/arlo.service "$backup_dir/arlo.service"
install -m 0600 "$env_dir/images.env" "$backup_dir/images.env"

rollback_required=true
install -m 0644 "$work_dir/release/docker-compose.yml" "$app_dir/docker-compose.yml"
install -m 0755 "$work_dir/release/start.sh" "$app_dir/start.sh"
install -m 0644 "$work_dir/release/arlo.service" /etc/systemd/system/arlo.service
install -m 0600 "$work_dir/release/images.env" "$env_dir/images.env"
systemctl daemon-reload
systemctl restart arlo.service

for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null &&
     curl -fsS http://127.0.0.1:3001/ >/dev/null &&
     docker ps -q --filter 'label=com.docker.compose.service=rtms' --filter status=running | grep -q .; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo "Local health checks did not pass"
    exit 1
  fi
  sleep 2
done

for attempt in $(seq 1 30); do
  if curl -fsS "${PUBLIC_URL}/health" >/dev/null; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    echo "Public health check did not pass"
    exit 1
  fi
  sleep 2
done

rollback_required=false
trap cleanup EXIT
find "$rollback_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
  sort -rn | awk 'NR > 3 {sub(/^[^ ]+ /, ""); print}' | xargs -r rm -rf
docker image prune -af --filter 'until=168h' >/dev/null
echo "Successfully deployed ${source_commit}"
