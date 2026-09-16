# Web CI

The Web workflows use `npm run setup:external` to download the pinned Web
artifacts into `external/emscripten`. The version comes from the root
`external-config.json`; `workflows/get-external-version.js` prints that version.
No native engine checkout or SWIG generation is required.

## Updating Spine

`build-wasm-libs.yml` builds Spine 3.8 and 4.2 as WASM and ASM.js with Emscripten
3.1.41. Its shared `workflows/build-spine.sh` reads `vendor/wasm/spine-wasm` and
the adjacent `vendor/wasm/spine` sources. It passes `SPINE_VERSION` and
`BUILD_WASM` to CMake without editing source files, and restores the embind
patch on both success and failure.

The workflow uploads `dist/3.8` and `dist/4.2` as `spine-emscripten`. Publish
these files to the Web external artifact and update `external-config.json`.
Keep the other Web libraries, including compression and deserialize. Interface
CI compares all eight generated files with the pinned artifact before using
the new files for the Web and WeChat package-size checks.

## External Prerequisites

Both refs in an interface comparison must contain the Web-only layout and
`setup:external`. Comparisons across the migration boundary and API-doc builds
of older native-era refs are not supported by these workflows.

The self-hosted Windows/macOS test jobs still depend on the external
`@cctest/scheduler`, test projects, automation plugin, device configuration, and
`python/main.py --target=job_editor`. The `PR-TEST` and `PR-TEST-DEFERRED`
profiles and their numeric task IDs are defined outside this repository.
Runner owners must confirm that these profiles exercise Web, mini games,
runtime, and Creator without native build/publish tasks. Removing the local
SWIG steps cannot validate or reconfigure those external profiles.
