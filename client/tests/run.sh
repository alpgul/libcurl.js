#!/bin/bash

set -e

trap "exit" INT TERM
trap "kill 0" EXIT

# The wisp proxy is the Cloudflare Worker (server/worker-wisp-server). It can run locally
# (`docker compose up -d`) or be deployed to Cloudflare. Edit HOST if needed.
HOST="http://localhost:8787"

echo -n "waiting for wisp worker on $HOST"
i=0
until curl --output /dev/null --silent --head "$HOST/"; do
  if [ "$i" = "30" ]; then
    echo -e "\ntests failed. wisp worker not responding on $HOST"
    exit 1
  fi

  echo -n "."
  i=$(($i+1))
  sleep 1
done
echo


# serve the static test files locally (the wisp/ws traffic flows through the worker)
python3 -m http.server 8788 >/dev/null 2>&1 &

echo "wisp worker ready, running tests"
export SE_AVOID_STATS=true #turn of selenium telemetry
python3 tests/run_tests.py