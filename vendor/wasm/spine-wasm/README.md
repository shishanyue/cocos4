# Spine WASM Compilation Guide

This directory contains the shared WebAssembly/ASM.js adapter. The adjacent
`../spine` directory contains the Spine 3.8 and 4.2 runtime sources and their
license notices. These sources build independently with EMSDK; no native engine
or platform templates are required.

## Requirements

- EMSDK 3.1.41, installed and activated following the official EMSDK documentation.
- CMake and Ninja on `PATH`.

Activate the EMSDK environment before configuring. On Linux/macOS, run
`source /path/to/emsdk/emsdk_env.sh`; on Windows, run the SDK's `emsdk_env.bat`.

## Build

Run from the engine repository root. Build directories may be outside the source
tree; the following examples use `/tmp` (choose a suitable path on Windows).

```bash
emcmake cmake -S vendor/wasm/spine-wasm -B /tmp/spine-wasm-3.8 -G Ninja \
  -DSPINE_VERSION=3.8 -DBUILD_WASM=1 -DCMAKE_BUILD_TYPE=MinSizeRel
cmake --build /tmp/spine-wasm-3.8
```

All three options are CMake cache variables; no source edits are needed:

- `SPINE_VERSION`: `3.8` (default) or `4.2`.
- `BUILD_WASM`: `1` (default) for WebAssembly, or `0` for ASM.js.
- `CMAKE_BUILD_TYPE`: `MinSizeRel` (default), `Release`, `RelWithDebInfo`, or `Debug`.

Use separate build directories for each version and output format. For example:

```bash
emcmake cmake -S vendor/wasm/spine-wasm -B /tmp/spine-asmjs-4.2 -G Ninja \
  -DSPINE_VERSION=4.2 -DBUILD_WASM=0 -DCMAKE_BUILD_TYPE=MinSizeRel
cmake --build /tmp/spine-asmjs-4.2
```

## Artifacts

For publishable artifacts, use the CI helper from the repository root in a Bash
environment with EMSDK activated:

```bash
bash .github/workflows/build-spine.sh /tmp/spine-dist
```

It builds both versions and formats, temporarily applies the checked embind
`bind.cpp` patch, and restores the SDK file on exit. The direct CMake commands
above are unpatched local builds, not the publishing recipe. Do not run other
builds against the same SDK while the helper is running.

- WebAssembly: retain `spine.wasm` and rename `spine.js` to `spine.wasm.js`.
- ASM.js: retain `spine.js.mem` when emitted and rename `spine.js` to `spine.asm.js`.

Publish the artifacts to `emscripten/spine/<version>/` in the external dependency
distribution identified by the repository-root `external-config.json`.
The external artifacts and EMSDK are not bundled with these sources. Building
here does not download dependencies or create a compatibility directory.
