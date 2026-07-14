#!/usr/bin/env bash
set -euo pipefail

image="${KOSH_CI_IMAGE:-kosh-ci:${GITHUB_SHA:-local}}"
docker build --target runner --tag "$image" .
docker run --rm --entrypoint sh "$image" -c '
  test "$(id -u):$(id -g)" = "1001:1001"
  test "$(stat -c %u:%g /app/data/storage)" = "1001:1001"
  test -w /app/data/storage
  touch /app/data/storage/.ci-write && rm /app/data/storage/.ci-write
  ! find /app -type f \( -name .env -o -name .env.local -o -name ".env.*" \) -print | grep -q .
'

DATABASE_URL=postgres://kosh:kosh@db:5432/kosh \
BETTER_AUTH_SECRET=ci-secret-0123456789abcdef0123456789 \
APP_URL=https://kosh.example.test \
KOSH_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
POSTGRES_PASSWORD=kosh \
docker compose --env-file /dev/null config --format json | node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  const port = config.services.web.ports.find((p) => Number(p.target) === 3000);
  if (!port || port.host_ip !== "127.0.0.1") {
    throw new Error(`web port is not loopback-only: ${JSON.stringify(port)}`);
  }
'
