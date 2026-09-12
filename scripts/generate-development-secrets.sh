#!/bin/sh
set -eu

target="${1:-deploy/secrets/local}"
mkdir -p "$target"
chmod 700 "$target"

generate_secret() {
  path="$target/$1"
  bytes="$2"
  if [ -e "$path" ]; then
    return
  fi
  umask 077
  openssl rand -base64 "$bytes" > "$path"
}

generate_secret postgres_admin_password 32
generate_secret core_db_password 32
generate_secret sunat_db_password 32
generate_secret webhook_db_password 32
generate_secret redis_health_password 32
generate_secret redis_worker_password 32
generate_secret redis_sunat_password 32
generate_secret redis_webhook_password 32
generate_secret jwt_secret 48
generate_secret api_key_pepper 32
generate_secret api_key_replay_key 32
generate_secret sunat_master_key 32
generate_secret webhook_master_key 32
generate_secret sunat_internal_secret 32
generate_secret webhook_internal_secret 32

printf '%s\n' "Generated local secrets in $target. Add R2 credentials manually."
