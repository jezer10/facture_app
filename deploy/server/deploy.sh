#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release=$(cd "$(dirname "$0")/../.." && pwd)
[[ "$release" =~ ^/srv/facture/releases/[a-f0-9]{40}$ ]] || { echo 'Invalid release directory' >&2; exit 1; }
exec 9>/srv/facture/deploy.lock
flock -n 9 || { echo 'Deployment already running' >&2; exit 1; }
export FACTURE_IMAGE_TAG=${release##*/}
export SECRET_DIR=/srv/facture/secrets
cd "$release"
for secret in postgres_admin_password core_db_password sunat_db_password webhook_db_password jwt_secret api_key_pepper api_key_replay_key sunat_master_key webhook_master_key sunat_internal_secret webhook_internal_secret aws_worker_credentials aws_sunat_credentials aws_webhook_credentials r2_api_access_key_id r2_api_secret_access_key r2_worker_access_key_id r2_worker_secret_access_key r2_sunat_access_key_id r2_sunat_secret_access_key beta_private.key beta_certificate.pem cloudflare_tunnel_token; do
  [[ -s "$SECRET_DIR/$secret" ]] || { echo "Missing deployment secret: $secret" >&2; exit 1; }
done
compose=(docker compose --project-name facture-beta --env-file /srv/facture/server.env -f compose.yaml -f compose.beta.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" pull
"${compose[@]}" up -d --no-build --wait postgres mailpit
mkdir -p /srv/facture/backups
"${compose[@]}" exec -T postgres pg_dumpall -U billing_admin | gzip > "/srv/facture/backups/before-${FACTURE_IMAGE_TAG}-$(date +%Y%m%dT%H%M%S).sql.gz"
# Stop consumers before changing the schema; leave persistent volumes intact.
"${compose[@]}" stop -t 60 billing-api billing-worker sunat-service webhook-service
"${compose[@]}" run --rm --no-deps migrations
# Run migrations once above, not as an implicit startup dependency.
"${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 180 billing-api billing-worker sunat-service webhook-service
"${compose[@]}" up -d --no-deps --no-build cloudflared
curl --fail --silent --show-error --retry 5 --retry-delay 3 http://127.0.0.1:3300/api/v1/health/ready
ln -sfn "$release" /srv/facture/current
printf '\nDeployed %s\n' "$FACTURE_IMAGE_TAG"
