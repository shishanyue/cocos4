# Windows Supervisor Component Qualification

This document describes the earlier, deliberately limited component ZIP. The
operational Windows development candidate is assembled separately by
`scripts/prepare-release.mjs --target win32-x64`; see [getting started](README.md)
and the [acceptance ledger](../ACCEPTANCE.md). Its implementation includes a
launcher, MCP/CLI, SDK, file/ACL helpers and publication. None of that upgrades an
already-created component ZIP or changes the manifest described below.

This is a **component qualification package**, NOT an operational Windows devkit,
release, SDK, game workflow, or redistribution approval. `components.json` uses
`cocos4-windows-host-components/v1`, `status: "blocked"`,
`operationalDevkit: false`, `distributionApproved: false`, and
`host.verified: false`. A valid checksum does not change any of those states.

## Contents And Limits

- Official pinned Node 24.21.0 x64: `runtime/node.exe`, `runtime/LICENSE`, and
  `runtime/README.md`. The reviewed executable is 93,580,104 bytes.
- Crossbuilt `build/windows-host/cocos4-supervise.exe` and
  `build/windows-host/windows-supervisor-fixture.exe`, each with the actual
  builder's `.exe.json` PE/compiler/source evidence. The fixture is acceptance
  machinery, not an application helper.
- `test/windows-supervisor.mjs` and `test/fixtures/windows-node-runner.mjs`
  in the harness's default layout. No npm, compiler or SDK is needed to attempt
  this component test using the bundled Node.
- C sources, build/archive/preparation scripts, focused maintainer tests, the
  reviewed Node pin, selected source hashes and a real Git dirty-state snapshot.
  Scripts and package locks are provenance, not a standalone build toolchain.
- Root `LICENSE`, `AUTHORS.txt`, `NOTICES.md`, Node notices, and actual Zig/MinGW
  notice files. Complete linked-object/license closure is still unreviewed.
- `evidence/node-pe.txt` retains bounded LLVM file-header, section, import and
  load-config output. `evidence/node-pe.json` binds it to the actual Node hash,
  tool executable and source snapshot, and preserves import names and symbols.

There is no `cocos4.exe`, launcher, application, MCP/CLI, compiler, npm, SDK,
engine payload, mini-game build capability, or preview server in this package.
The C supervisor's Windows 10 API floor is not the supported package test floor:
**acceptance on a supported Windows 11 x64 installation is required and unrun**.
PE subsystem versions do not establish supported Windows versions.

The inspected Node imports ADVAPI32, CRYPT32, dbghelp, IPHLPAPI, KERNEL32, ole32,
SHELL32, USER32, USERENV, WINMM and WS2_32 DLL names. This is NOT a safe-library
allowlist or proof those DLLs/ordinals are available on a host. Dynamic loading,
transitive imports, system servicing, CRT, DLL search and extraction/ACL behavior
remain unverified. Node's own Job Object imports do not establish its integration
with the new supervisor. The certificate table is not an Authenticode verification.
Relocation directory sizes are recorded, not a full relocation audit. Compiler
and LLVM hashes do not cover their complete libraries/resources/cache closures.

## Missing Qualification

- Windows filesystem identity, reparse-point handling and stable application I/O.
- Windows ACL/ownership, extraction and DLL loading policy.
- Private state, locks, recovery and persistent job ownership.
- Atomic no-replace Windows application publication.
- Compiler/package I/O integration and any actual Windows SDK/game workflow.
- Preview authorization, serving and browser integration.
- Shipping launcher and application/MCP/CLI/supervisor integration.
- Real supported Windows 11 acceptance, including bundled Node, native process
  lifetime cases, DLL availability, poisoned environments, ACLs and host behavior.
- Source authentication, full redistribution/license review and distribution approval.

## Maintainer Assembly

Run from the trusted Linux repository's `tools/devkit` directory, with existing
pinned maintainer dependencies installed. The assembler **never downloads** and
never executes Windows binaries, including through Wine. It requires Linux Node,
`/usr/bin/unzip`, `/usr/bin/llvm-readobj`, Git and `/usr/bin/python3` with libc
`renameat2`, plus an explicit Zig 0.16.0 installation. Both the assembler and
`scripts/build-supervisor-win32.mjs` require an absolute `--compiler` option;
neither has a personal default or searches PATH. The following is a local example:

```sh
node scripts/prepare-windows-components.mjs \
  --node-archive /tmp/opencode/node-v24.21.0-win-x64.zip \
  --compiler /home/shishanyue/.local/bin/zig \
  --out /home/shishanyue/GitHub/cocos4/tools/devkit/build/minigame-delivery/windows-host-components-20261002-r2
```

The output parent must already exist and be canonical. The output directory,
`.zip`, `.zip.sha256`, and `.build.json` must all be absent. The supplied ZIP is
bounded, stable-read and checked against the reviewed official SHA-256 before
extracting only the three exact members from a private copy. No general ZIP
extraction or hostile-workspace security is claimed. Input trees/output parents
must be trusted and quiescent; unrelated Git changes are reported, not reverted.

Each output is published with the existing parent-only `publishSdk` Linux
`renameat2(RENAME_NOREPLACE)` helper. The four outputs are not one transaction;
the build receipt is published last. Failure retains diagnostic staging and any
already-published output, never overwrites conflicts or touches an old candidate.
The receipt distinguishes Linux integrity/PE checks from unrun Windows acceptance.

The ZIP root is
`cocos4-windows-host-components-0.0.0-candidate-win32-x64`. ZIP bytes use sorted
UTF-8 names, fixed DOS 1980 timestamps and STORE encoding, with exact independent
inventory verification. Limits: 16,384 entries, 128 MiB/file, 512 MiB payload,
544 MiB archive, 1,024 bytes/name, 255 bytes/component, 4 MiB aggregate names and
depth 32. Deterministic ZIP encoding for identical inputs does not claim repeatable
crossbuild timestamps, compiler closures, temporary paths or Git snapshots.

`components.json` inventories every payload file except itself; its component ID
hashes the canonical manifest without that ID. The external receipt/ZIP inventory
also hash the manifest. These hashes bind actual bytes and selected sources;
**they do not authenticate source, signatures, authors or release clearance**.
The official Node pin was reviewed against a separately fetched HTTPS checksum
list, not a detached signature. A manifest and payload rewritten together are
not authenticated by their newly computed checksums.

## Manual Windows Component Test

The explicitly invoked `test/windows-supervisor.mjs` harness is not in the
normal `test/*.test.mjs` Linux regression glob. Invoking it on a non-win32 host
fails before artifact access or execution, rather than reporting a skipped test.

Use a trusted, supported Windows 11 x64 test host and a separately reviewed
extraction directory/ACL. This is a manual acceptance attempt, NOT normal devkit
startup. There is no shipping launcher to sanitize the initial Node environment.
`NODE_OPTIONS` can execute code before Node starts the test: clearing it inside
JavaScript is too late. Start a trusted PowerShell without profiles, move to the
extracted kit root, and explicitly remove poison/override variables from the
current process environment case-insensitively **before launching Node**:

```powershell
Get-ChildItem Env: | Where-Object {
    $_.Name -imatch '^(NODE_.*|OPENSSL_CONF|OPENSSL_MODULES|SSL_CERT_FILE|SSL_CERT_DIR|ICU_DATA|COCOS4_WINDOWS_.*)$'
} | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }

# Set this to a new absolute directory if acceptance reports must be retained.
$env:COCOS4_WINDOWS_ACCEPTANCE_DIR = 'C:\cocos4-acceptance\new-component-run'
& .\runtime\node.exe --no-global-search-paths --test test\windows-supervisor.mjs
```

Ensure the report parent exists and the report directory is absent. Restore or
verify OS-provided `SystemRoot`, `WINDIR`, `PATH`, `TEMP`, `TMP` and profile values
in this trusted shell; the reset above is not an OS environment/ACL sandbox and
does not validate DLLs. Never use a PATH/global Node fallback. The harness then
deliberately supplies poisoned environments to supervisor children to test its
separate environment policy. It must not inherit overrides from a previous run.

Retain `host.json`, `run.json`, `transcripts.json`, fixture observations and test
output for review. Harness success is component evidence only, not application,
preview, SDK, publishing, hostile-code isolation or distribution qualification.
Wrong-host rejection and Wine smoke cannot substitute for real Windows acceptance.
