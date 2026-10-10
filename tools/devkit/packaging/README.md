# Portable Candidate

AI agents working in the extracted package should start with root `AGENTS.md`.
It identifies the bundled skills, MCP connection and CLI workflow, external game
workspace/state roots, profiles, permissions and job-result checks. The release
inventory and provenance bind it to `packaging/AGENTS.md`; it is not the source
checkout's engine-maintenance guide.

This is a **local verification candidate** for the operating system recorded in
`release.json` (Linux x64 or Windows 11 x64), not a release cleared for
redistribution. Read the packaged `THIRD_PARTY_NOTICES` and `docs/acceptance.json` before sharing
any files. License provenance, clean-machine and supported-host acceptance remain
open. Source integrity and archive checksums are not publisher authentication.

The package contains Node 24.21.0, compiled MCP/CLI code, the application dependency
closure, host helpers, real Node declarations, the SDK's delivered game profiles,
game compiler, API docs, resources and skills. Legacy eight-profile HTML5/BILIBILI
SDKs remain valid. Current source exporters also support WECHAT/BYTEDANCE when
their profiles are delivered; every candidate target requires genuine 2D/3D
debug/release profiles. The four-target, 16-profile SDK, Linux candidate and
packaged 2048 WeChat/ByteDance demo were assembled locally on October 1, 2026.
Their retained evidence is described in the checkout's `tools/devkit/ACCEPTANCE.md`;
assembly and local source preflight do not establish complete package acceptance
or vendor/device rendering. The original SDK lives in `sdk/` unchanged;
`release.json` describes this particular enclosing distribution.
Its own statement that Node is not bundled describes that inner SDK, not the kit.

Use the `cocos4` (Linux) or `cocos4.exe` (Windows) launcher from any working directory. It locates
its bundled Node without PATH lookup and removes Node/dynamic-loader injection
variables before starting it. Keep projects and private state outside the package.
`doctor` without `--workspace` checks only the release inventory, SDK and host read
support, including from the read-only extraction directory. It does not authorize
the SDK or current directory as a workspace, inspect projects, create state, or
require `HOME`/`XDG_STATE_HOME`. It emits one JSON object with `scope: "sdk-only"`,
release/SDK identities and a structured report. Failures emit structured stderr
and exit nonzero; no preparation, repair, downloads or client startup is attempted.

For other commands, workspace defaults to the current directory and must be outside
the release. Explicit-workspace doctor uses the shared job workflow and private
state, just like MCP/CLI. Default state for those commands is
`$XDG_STATE_HOME/cocos4` or `$HOME/.local/state/cocos4` on Linux, and
`%LOCALAPPDATA%\cocos4` or `%USERPROFILE%\AppData\Local\cocos4` on Windows; `--state-root` selects an
explicit external path. SDK-only doctor rejects `--state-root` and develop,
preview or test-execution grants without `--workspace` rather than ignoring them.

```sh
./cocos4 doctor
/absolute/path/to/kit/cocos4 doctor --workspace /absolute/path/to/games
/absolute/path/to/kit/cocos4 mcp --workspace /absolute/path/to/games --mode develop --preview true
/absolute/path/to/kit/cocos4 mcp --workspace /absolute/path/to/trusted-games --mode develop --execute-tests true
/absolute/path/to/kit/cocos4 ai --client opencode --executable /absolute/path/to/opencode --workspace /absolute/path/to/games --mode develop --preview true
```

On this Windows host, extract the ZIP beneath the protected private directory
`D:\cocos4-work`, keeping kit, games and state in separate sibling directories.
Configure tool TEMP/TMP/TMPDIR there. Use canonical local drive paths; network paths, junctions,
symlinks, alternate data streams and shared writable installation directories are
rejected. Keep an existing games directory separate from the kit and private state:

```powershell
& 'D:\cocos4-work\kit\cocos4.exe' doctor
& 'D:\cocos4-work\kit\cocos4.exe' mcp --workspace 'D:\cocos4-work\games' --state-root 'D:\cocos4-work\state' --mode develop --preview true
```

OpenCode is optional: the CLI and stdio MCP server run independently. The
reference `ai` adapter is not accepted on Windows with OpenCode 1.18.21 / Bun
1.3.14: MCP connection succeeds, but the client's code loader fails to import
the guarded tool module under its read-only file ACL. The adapter retains that
protection. Use the MCP/CLI directly; this package does not claim a completed
Windows AI workflow. Linux reference-client acceptance is recorded separately.

Windows PowerShell 5.1 extraction is limited by MAX_PATH. Extract into a short
private path beneath the designated work directory first. Longer Unicode paths can be tested after
relocating the extracted directory; the host acceptance records the extraction
and relocation as separate steps.

The first command runs in the extraction directory. The portable launcher fixes
the SDK to this release and rejects `--sdk-root`. AI requires the explicit path
to an already installed supported client via `--executable`; it does not search
PATH or install one. Source-checkout maintainer `node .../build/src/cli.js`
commands instead require explicit SDK/workspace/state roots and are not portable
launcher instructions.

Doctor success establishes only the checks named in its report. It does not test
publisher/supervisor kernel features, launch a browser, check the installed AI
client/model, or approve the candidate for distribution.

No system Node, npm, Git, Python, compiler, Creator, download or postinstall is
needed by the installed game workflow. Linux requires procfs, renameat2, pidfds
and subreapers. Windows uses bundled PE helpers for file handles/ACLs, atomic
publication, clean MCP startup and Job Object process lifetime management.
The OS libraries/versions recorded in `acceptance.json` are required. Browser
preview needs an installed browser. The optional `ai --client opencode` command
needs the reviewed OpenCode 1.18.21 client and model access; other MCP clients use
the launcher directly. Model networking is separate from offline kit operation.
Each archive runs only on its declared host. macOS does not yet have a candidate.

Windows host development is separate from engine publishing targets. The complete
Windows candidate contains `cocos4.exe`, the MCP/CLI, bundled Node, helpers and SDK.
The older component qualification ZIP described in the checkout's
`tools/devkit/packaging/WINDOWS-COMPONENTS.md` remains a separate supervisor harness.
Neither package enables native game applications, NATIVE or JSB. Consult the
checkout's `tools/devkit/ACCEPTANCE.md` for actual host and workflow evidence;
assembly alone does not establish those results.

MCP tools default to read-only. Startup grants cannot be elevated through tool
arguments. Project creation, checks, builds and preview require `requestKey`;
reusing a key reuses its retained job, not newly edited inputs. Read the terminal
job state and paginated report, not only a successful receipt/query. Logic tests
need the separate execute-tests grant and run trusted code, **not a sandbox**.
That code can access host files/processes/network; use OS isolation for untrusted
projects. The AI launcher currently does not grant logic execution.

The client's guarded file tools are `cocos4_read`, `cocos4_write`, `cocos4_edit`
and `cocos4_apply_patch`. Built-in file tools are disabled for known permission
problems in the supported client. Normal game edits use those guarded tools;
SDK, secret and client configuration files are not editable through them.

HTML5 artifacts can be previewed on a tokenized loopback URL. BILIBILI, WECHAT and
BYTEDANCE artifacts are unsplit `game.js` source packages with preserved licenses,
static closure/source preflight, not browser previews, vendor-compiled/uploaded
packages or verified device rendering. WECHAT/BYTEDANCE use genuine `wx`/`tt`
adapters, matching loaders and engine flags, not renamed BILIBILI bundles.
Their starters create `platforms/wechat/{game.json,project.config.json}` or
`platforms/bytedance/{game.json,project.config.json}` with blank `appid`; users set
real `wx`/`tt` IDs in `project.config.json`. Build copies both files verbatim to
the export root. Subpackages, plugins, open-data contexts, workers and cloud
export remain unsupported. Shipped BILIBILI projects retain root `game.json`.
The adapters' `@cocos/engine-platforms@1.0.6` metadata declares `UNLICENSED`;
preserving it and the engine license does not resolve redistribution approval.
Browser pixels/input/audio must be tested separately from HTTP preview delivery.

Upgrade by extracting a new kit beside the old one, verify its source and
checksums separately, then restart the client with the new launcher. Do not
overwrite a running kit. Preserve old projects/artifacts and use their recorded
SDK/profile identities when diagnosing differences.
