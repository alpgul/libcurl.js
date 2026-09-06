#!/bin/bash

#compile boringssl (lexiforest impersonate fork) for use with emscripten

set -x
set -e

CORE_COUNT=$(nproc --all)
PREFIX=build/boringssl-wasm
mkdir -p $PREFIX
PREFIX=$(realpath $PREFIX)
rm -rf $PREFIX
mkdir -p $PREFIX

cd build
rm -rf boringssl
git clone -b impersonate --depth=1 https://github.com/lexiforest/boringssl boringssl

cd boringssl
mkdir -p build
cd build

COMMON_FLAGS="-DOPENSSL_NO_ASM -DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED"

emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$COMMON_FLAGS" \
  -DCMAKE_CXX_FLAGS="$COMMON_FLAGS" \
  -DOPENSSL_NO_ASM=1 \
  -DBORINGSSL_ALLOW_CXX_RUNTIME=0

emmake cmake --build . --config Release --target ssl -j$CORE_COUNT

cp -r ../include $PREFIX/
mkdir -p $PREFIX/lib
cp libcrypto.a $PREFIX/lib/libcrypto.a
cp libssl.a $PREFIX/lib/libssl.a

cd ../../..