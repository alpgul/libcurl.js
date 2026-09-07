#!/usr/bin/env bash
# Pull the client build artifacts out of the shared compose volume onto the host.
# Bind mounts are unavailable in this docker setup, so the `client` service writes
# into the named volume (libcurljs_out) and this script extracts it to:
#   - client/out/                        the dev workspace copy
#   - server/worker-wisp-server/assets/  libcurl.js + libcurl.wasm (for image rebuild / deploy)
# Usage: client/tools/sync-static.sh [volume]
set -euo pipefail
cd "$(dirname "$0")/.."
VOL="${1:-libcurljs_out}"
mkdir -p out
docker run --rm -v "$VOL:/out" alpine sh -c 'tar -C /out -cf - .' | tar -xf - -C out/
echo "synced $(ls out | wc -l) files into client/out/"

WORKER_ASSETS="../server/worker-wisp-server/assets"
if [ -d "$WORKER_ASSETS" ]; then
  for f in libcurl.js libcurl.wasm; do
    if [ -f "out/$f" ]; then
      cp "out/$f" "$WORKER_ASSETS/"
      echo "copied $f -> $WORKER_ASSETS/"
    fi
  done
fi