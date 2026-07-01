#!/bin/sh
# Run E2E smoke test inside Playwright Docker container
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

DOCKER_HOST= docker --context rootless run --rm --network=host --shm-size=2g \
  -v "${SCRIPT_DIR}:/src:ro" \
  mcr.microsoft.com/playwright:v1.61.1-noble \
  sh -c 'set -eu
workdir="$(mktemp -d)"
cp -R /src/. "$workdir"
rm -rf "$workdir/node_modules"
cd "$workdir"
npm install --no-audit --fund=false 2>/dev/null
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node e2e-smoke.mjs'
