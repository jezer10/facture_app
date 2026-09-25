#!/bin/sh
set -eu

core_password="$(tr -d '\r\n' < /run/billing-postgres-secrets/core_db_password)"
sunat_password="$(tr -d '\r\n' < /run/billing-postgres-secrets/sunat_db_password)"
webhook_password="$(tr -d '\r\n' < /run/billing-postgres-secrets/webhook_db_password)"

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=core_password="$core_password" \
  --set=sunat_password="$sunat_password" \
  --set=webhook_password="$webhook_password" <<'SQL'
CREATE ROLE billing_core LOGIN PASSWORD :'core_password';
CREATE ROLE billing_sunat LOGIN PASSWORD :'sunat_password';
CREATE ROLE billing_delivery LOGIN PASSWORD :'webhook_password';
CREATE DATABASE billing_core OWNER billing_core;
CREATE DATABASE billing_sunat OWNER billing_sunat;
CREATE DATABASE billing_delivery OWNER billing_delivery;
SQL
