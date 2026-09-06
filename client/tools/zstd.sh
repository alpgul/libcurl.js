#!/bin/bash

#compile zstd for use with emscripten

set -x
set -e

CORE_COUNT=$(nproc --all)
PREFIX=$(realpath build/zstd-wasm)

cd build
rm -rf zstd
git clone -b v1.5.7 --depth=1 https://github.com/facebook/zstd
cd zstd

emmake make -j$CORE_COUNT lib-release

rm -rf $PREFIX
mkdir -p $PREFIX/include
mkdir -p $PREFIX/lib
cp -r lib/*.h $PREFIX/include
cp lib/libzstd.a $PREFIX/lib

cd ../..