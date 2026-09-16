#!/usr/bin/env bash
set -euo pipefail

# Run from the engine checkout; the script and patch may come from the PR head.
source_dir="vendor/wasm/spine-wasm"
dist_dir="${1:-dist}"
bind_cpp="${EMSDK:?EMSDK must point to the Emscripten SDK}/upstream/emscripten/system/lib/embind/bind.cpp"
backup="$(mktemp)"
cp "$bind_cpp" "$backup"
trap 'cp "$backup" "$bind_cpp"; rm -f "$backup"' EXIT
cp "$(dirname "$0")/emscripten-patches/embind/bind.cpp" "$bind_cpp"

for version in 3.8 4.2; do
    wasm_dir="$source_dir/build-$version-wasm"
    asmjs_dir="$source_dir/build-$version-asmjs"
    emcmake cmake -S "$source_dir" -B "$wasm_dir" -GNinja -DSPINE_VERSION="$version" -DBUILD_WASM=1
    cmake --build "$wasm_dir"
    emcmake cmake -S "$source_dir" -B "$asmjs_dir" -GNinja -DSPINE_VERSION="$version" -DBUILD_WASM=0
    cmake --build "$asmjs_dir"

    mkdir -p "$dist_dir/$version"
    cp "$wasm_dir/spine.wasm" "$dist_dir/$version/"
    cp "$wasm_dir/spine.js" "$dist_dir/$version/spine.wasm.js"
    cp "$asmjs_dir/spine.js.mem" "$dist_dir/$version/"
    cp "$asmjs_dir/spine.js" "$dist_dir/$version/spine.asm.js"
done
