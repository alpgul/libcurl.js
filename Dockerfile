# build libcurl.js into WASM using emscripten
#
# the native deps (BoringSSL, zlib, brotli, zstd, nghttp2, curl-chrome) are
# compiled into client/build/ and kept on the host as the source of truth (see
# client/tools/all_deps.sh). docker copies them in as-is: the COPY layer is only
# re-fetched when the host files change, so edits to the c/js sources rebuild
# just the wrapper in ~minutes and never recompile the deps.
FROM emscripten/emsdk:3.1.72 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    make cmake autoconf automake libtool pkg-config wget xxd jq git python3 python3-jinja2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .
RUN git submodule update --init --recursive || true

WORKDIR /src/client
RUN ./build.sh all

# final image: just the built client artifacts, used by client/tools/sync-static.sh
# the proxy server itself is the Cloudflare Worker (server/worker-wisp-server)
FROM alpine:3.20 AS static
COPY --from=builder /src/client/out /app/static