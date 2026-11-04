#!/bin/sh
# Builds the WebAssembly engine (engine/js/build.sh) and copies what the volume layer loads at run time to
# public/engine/ (index.mjs and pkg/squad_engine.js, pkg/squad_engine_bg.wasm; the SIMD build is not needed).
# `npm run build` copies public/ to dist/. Without this step the site builds and runs; the volume layer
# then finds no engine and every feature keeps using the heightmap.
set -eu
cd "$(dirname "$0")/.."
sh engine/js/build.sh
mkdir -p public/engine/pkg
cp engine/js/index.mjs public/engine/index.mjs
cp engine/js/pkg/squad_engine.js engine/js/pkg/squad_engine_bg.wasm public/engine/pkg/
