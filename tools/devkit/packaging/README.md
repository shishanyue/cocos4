# Portable Candidate

This is a Linux x64 **local verification candidate**, not a release cleared for
redistribution. Read `../THIRD_PARTY_NOTICES` and `acceptance.json` before sharing
any files. License provenance, clean-machine and supported-host acceptance remain
open. Source integrity and archive checksums are not publisher authentication.

The package contains Node 24.21.0, compiled MCP/CLI code, the application dependency
closure, host helpers, real Node declarations, eight HTML5/BILIBILI 2D/3D
debug/release profiles, game compiler, API docs, resources and skills. The original
SDK lives in `sdk/` unchanged; `release.json` describes the enclosing distribution.
Its own statement that Node is not bundled describes that inner SDK, not the kit.

Use the `cocos4` launcher from any working directory. It locates
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
`$XDG_STATE_HOME/cocos4` or `$HOME/.local/state/cocos4`; `--state-root` selects an
explicit external path. SDK-only doctor rejects `--state-root` and develop,
preview or test-execution grants without `--workspace` rather than ignoring them.

```sh
./cocos4 doctor
/absolute/path/to/kit/cocos4 doctor --workspace /absolute/path/to/games
/absolute/path/to/kit/cocos4 mcp --workspace /absolute/path/to/games --mode develop --preview true
/absolute/path/to/kit/cocos4 mcp --workspace /absolute/path/to/trusted-games --mode develop --execute-tests true
/absolute/path/to/kit/cocos4 ai --client opencode --executable /absolute/path/to/opencode --workspace /absolute/path/to/games --mode develop --preview true
```

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
needed by the installed game workflow. Linux procfs, renameat2, pidfds, subreapers
and the OS libraries/versions recorded in `acceptance.json` are required. An
installed browser and, for AI, supported OpenCode 1.18.21 and model access remain
external prerequisites. AI networking is separate from offline kit operation.
Windows and macOS are not verified or supported by this candidate.

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

HTML5 artifacts can be previewed on a tokenized loopback URL. BILIBILI artifacts
are source game packages with static module/resource validation and local
preflight, not vendor-compiled/uploaded packages or verified device rendering.
Browser pixels/input/audio must be tested separately from HTTP preview delivery.

Upgrade by extracting a new kit beside the old one, verify its source and
checksums separately, then restart the client with the new launcher. Do not
overwrite a running kit. Preserve old projects/artifacts and use their recorded
SDK/profile identities when diagnosing differences.
