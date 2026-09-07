# build libcurl.js into WASM using emscripten
FROM emscripten/emsdk:3.1.72 AS deps

# layer 1: build all native deps (BoringSSL, zlib, brotli, zstd, nghttp2, curl-chrome).
# This layer only invalidates when the dep tool scripts change, so it stays cached
# across normal JS/C source edits for fast incremental rebuilds.
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    make cmake autoconf automake libtool pkg-config wget xxd jq git python3 python3-jinja2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY client/tools ./client/tools
WORKDIR /src/client
RUN tools/all_deps.sh

FROM emscripten/emsdk:3.1.72 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    make cmake autoconf automake libtool pkg-config wget xxd jq git python3 python3-jinja2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .
RUN git submodule update --init --recursive || true

# reuse the prebuilt deps so only the c/js sources are recompiled
COPY --from=deps /src/client/build /src/client/build
WORKDIR /src/client
RUN ./build.sh all

# final image: just the built client artifacts, used by client/tools/sync-static.sh
# the proxy server itself is the Cloudflare Worker (server/worker-wisp-server)
FROM alpine:3.20 AS static
COPY --from=builder /src/client/out /app/static