#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# GITHUB_TOKEN arrives only via stdin; remove registry authentication on every exit.
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
docker login ghcr.io --username "${REGISTRY_USER:?}" --password-stdin
bash "$(dirname "$0")/deploy.sh"
