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

# serve the built libcurl.js and the wisp proxy server
FROM python:3.12-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends git netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /src/server/wisp_server ./wisp_server
RUN pip install --no-cache-dir -e ./wisp_server

COPY --from=builder /src/client/out /app/static
COPY test/browserleaks.html /app/static/index.html

EXPOSE 6001
CMD ["python3", "-m", "wisp.server", "--host", "0.0.0.0", "--port", "6001", "--static", "/app/static", "--allow-private", "--allow-loopback"]