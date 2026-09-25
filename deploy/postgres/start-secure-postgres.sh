#!/bin/sh
set -eu

# Compose file-backed secrets preserve their host ownership. The official image
# runs initialization scripts as postgres, so prepare private ephemeral copies
# before its entrypoint drops privileges.
source_dir=/run/secrets
target_dir=/run/billing-postgres-secrets

umask 077
mkdir -p "$target_dir"
chown postgres:postgres "$target_dir"
chmod 0700 "$target_dir"

for secret_name in \
  postgres_admin_password \
  core_db_password \
  sunat_db_password \
  webhook_db_password
do
  source_path="$source_dir/$secret_name"
  target_path="$target_dir/$secret_name"

  if [ ! -f "$source_path" ]; then
    printf '%s\n' "Missing required PostgreSQL secret: $secret_name" >&2
    exit 1
  fi

  cp "$source_path" "$target_path"
  chown postgres:postgres "$target_path"
  chmod 0400 "$target_path"
done

exec /usr/local/bin/docker-entrypoint.sh "$@"
