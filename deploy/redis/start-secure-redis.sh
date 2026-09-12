#!/bin/sh
set -eu

secret_hash() {
  tr -d '\r\n' < "$1" | sha256sum | cut -d ' ' -f 1
}

health_hash="$(secret_hash /run/secrets/redis_health_password)"
worker_hash="$(secret_hash /run/secrets/redis_worker_password)"
sunat_hash="$(secret_hash /run/secrets/redis_sunat_password)"
webhook_hash="$(secret_hash /run/secrets/redis_webhook_password)"
restricted_commands='-acl -bgrewriteaof -bgsave -config -debug -failover -flushall -flushdb -function -latency -memory -module -monitor -psync -replconf -replicaof -restore -role -save -shutdown -slaveof -swapdb -sync -client|kill -client|pause -client|unpause -script|debug -script|flush -script|kill'
umask 077
printf '%s\n' \
  'user default off' \
  "user billing_health on #$health_hash ~* &* +ping" \
  "user billing_worker on #$worker_hash ~billing:* &billing:* +@all $restricted_commands" \
  "user billing_sunat on #$sunat_hash ~billing:billing.sunat.commands.v1:* ~billing:billing.sunat.results.v1:* &billing:billing.sunat.commands.v1:* &billing:billing.sunat.results.v1:* +@all $restricted_commands" \
  "user billing_webhook on #$webhook_hash ~billing:billing.webhooks.v1:* &billing:billing.webhooks.v1:* +@all $restricted_commands" \
  > /tmp/billing-users.acl
chown redis:redis /tmp/billing-users.acl /data
unset health_hash worker_hash sunat_hash webhook_hash restricted_commands

exec setpriv --reuid=redis --regid=redis --clear-groups redis-server \
  --appendonly yes \
  --appendfsync everysec \
  --maxmemory-policy noeviction \
  --aclfile /tmp/billing-users.acl
