#!/usr/bin/env bash
# Pull the wasm build artifacts out of the libcurl Docker image onto the host.
# No bind mounts needed (the host path is not shared with Docker on this setup).
# Usage: client/tools/sync-static.sh [image]
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${1:-libcurljs-libcurl}"
mkdir -p out
docker run --rm --entrypoint sh "$IMAGE" -c 'tar -C /app/static -cf - .' | tar -xf - -C out/
echo "synced $(ls out | wc -l) files into client/out/"