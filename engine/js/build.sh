#!/bin/sh
# Builds the wasm module twice with wasm-bindgen (--target web): js/pkg (plain) and js/pkg-simd (SIMD128
# triangle test). Needs `cargo install wasm-bindgen-cli --version 0.2.130` and the wasm32 target (both in
# ~/.cargo for the pinned toolchain).
set -eu
cd "$(dirname "$0")/.."
WASM=target/wasm32-unknown-unknown/release/squad_engine.wasm

cargo build --release --target wasm32-unknown-unknown --lib --features wasm
wasm-bindgen --target web --out-dir js/pkg "$WASM"

RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown --lib \
    --features wasm,simd --target-dir target/simd
wasm-bindgen --target web --out-dir js/pkg-simd target/simd/wasm32-unknown-unknown/release/squad_engine.wasm
