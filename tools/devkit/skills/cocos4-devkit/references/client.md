# Client Boundaries

The launcher starts a new, already installed OpenCode session using reviewed
OpenCode `1.18.21`. Historical client acceptance covers non-root Linux x64;
Windows client/model acceptance must be checked separately. It validates the
generated configuration using a bundled snapshot of the official JSON Schema;
runtime startup never fetches schemas or downloads a client.

Use the kit's `cocos4` (Linux) or `cocos4.exe` (Windows) entrypoint with explicit absolute paths:

```sh
/absolute/path/to/kit/cocos4 ai --client opencode --executable /absolute/path/to/opencode \
  --workspace /absolute/path/to/games \
  --state-root /absolute/path/to/private-state
```

The portable launcher selects its own SDK and rejects `--sdk-root`. The installed
client must be selected with `--executable`; it is not discovered on PATH or
downloaded. The workspace must exist. Release, workspace and private state must be disjoint.
State must be user-owned and private; the launcher never fixes permissions on an
existing directory. Linux root and unsupported hosts fail closed. No arguments after
`--`, arbitrary client flags, shell commands, prompts, resume flags or automatic
model requests are accepted. Select develop and preview explicitly when needed:

```text
--mode develop --preview true
```

Develop allows ordinary game file edits and the development MCP tools. Shell,
network tools, subagents, client config edits and secret-file edits remain denied.
AI does not grant test execution and rejects `--execute-tests`. Trusted `node:test`
logic checks require a separately authorized MCP/CLI session with
`--mode develop --execute-tests true`; tool arguments cannot grant this permission.
Use the bundled client tools, not the unsafe built-ins:

| Client Tool | Authorized Operations |
| --- | --- |
| `cocos4_read` | Bounded UTF-8 file reads and directory listings in the workspace, SDK and bundled skills |
| `cocos4_write` | Create or replace a workspace game text file in develop mode |
| `cocos4_edit` | Exact text replacement in a workspace game file in develop mode |
| `cocos4_apply_patch` | Validated Add/Update/Move/Delete text patches in develop mode |

Built-in `read`, `write`, `edit` and `apply_patch` are denied in both modes.
OpenCode `1.18.21` checks lexical paths before following links, and its patch tool
checks `edit` for a move's source, not its destination. Denying only
`permission.apply_patch` does not disable it: this client aliases all built-in
writers to `edit`. A before-execution plugin hook is not a sufficient replacement;
the client's debug tool executor bypasses it. The safe tools have distinct IDs
and enforce their own immutable startup policy even if a permission callback allows
an operation. No generic filesystem writer is added to MCP.

`grep`, `glob` and `list` remain denied. The reviewed client's `grep` authorizes
the query, not each matched file, and recursive search can download ripgrep. SDK
documentation search remains available through MCP.

## File Guarantees

The safe tools reject symbolic links in every path component, hardlinked regular
files, special files, traversal and protected secret/client-configuration names.
This applies to reads, existing files and every new destination, not just a startup
scan. SDK and skills are read-only. The workspace cannot overlap the bundled app,
skills, SDK, state or client/runtime executable. Directory ancestors must be owned
by trusted principals and not writable by other users. Linux permits root-owned
sticky temporary directories and requires procfs descriptor paths. Windows uses
local drive paths, rejects reparse points/UNC/alternate streams, and verifies ACLs
with the bundled filesystem helper; private state belongs to the current user.

Each operation pins directories component by component (`O_NOFOLLOW` descriptors
on Linux, protected handles on Windows), checks root/file/link-count identity and
rechecks directory locations and file versions. Reads release no text after a
detected replacement race. Writes publish new inodes without writing through an
existing file, so a late symlink or hardlink cannot redirect a content write.

Patches validate all source and destination endpoints, exact hunks and output
budgets before publishing any game-file changes. Add and Move never overwrite
an existing destination. All parent directories must already exist; create the
initial project through the development MCP. Files are limited to 1 MiB of UTF-8
text, a transaction to 8 MiB of inputs/outputs and 64 file operations, and a patch
to 256 hunks. Ambiguous context, binary data and unsupported syntax are rejected,
not guessed. Directory listing stops at 10,000 entries. Reads support `offset`
and `limit`; SDK API search is preferable to reading large generated declarations.

Cooperating safe tools serialize writes with `.cocos4-ai-file-lock`. Failed
publication rolls back owned entries without overwriting a concurrent actor's
file. If rollback or cleanup cannot safely finish, the lock and owned recovery
files are retained; inspect them locally before retrying. Do not delete a live
session's lock. This is not crash-atomic multi-file storage: process or machine
death can leave a partially published transaction requiring recovery.

The launcher, installed OpenCode, bundled app/skills and host filesystem remain
trusted. Descriptor checks are not OS isolation against hostile same-UID processes,
mount manipulation, client/kit tampering or an administrator. Path rules also
cannot identify secret contents copied into an ordinary authorized file. Untrusted
projects or concurrent adversarial processes require a separate OS isolation
boundary. Tool/stdio tests do not establish model, browser or device acceptance.

## Isolation And Authentication

Only the child receives `OPENCODE_CONFIG` and isolated OpenCode home/config/data/
cache/state paths. `HOME` and provider authentication environment variables are
preserved for that child; they are not serialized to the generated config or logs.
Existing client configuration, plugins and stored OAuth/authentication files are
not imported or copied. Models requiring those files, custom provider config or
third-party auth plugins are not supported by this isolated entrypoint. Supply
an already configured environment-based provider outside the tool if desired.
Do not log keys, copy credentials into a config, run an authentication flow, or
use someone else's active session to work around missing model access.

External/project configuration and skills are not loaded. Conflicting explicit
OpenCode environment settings, managed configuration, reserved `cocos4` server/
agent names and bundled skill names are rejected. Malformed or uninspectable
configuration/skills fail closed. Unrelated client configs are left untouched and
reported as not imported. Resolve a conflict yourself or select a separate clean
environment/workspace; the launcher never renames or overwrites user settings.

The tool-owned temporary config and `tools` directories are non-writable while
the client runs to prevent OpenCode's config dependency installation. The launcher
generates only a trusted `tools/cocos4.js` wrapper with fixed startup roots; it
imports the bundled `app/src/ai-files.js` beside `ai.js`. Both compiled modules
must be present in the release. The custom tools use Node built-ins only and do
not import or install `@opencode-ai/plugin`. The reviewed client discovers these
private tools even with `OPENCODE_PURE=1`; project/global tool directories remain
excluded. Missing safe tools do not re-enable built-ins.

Updates, model-list fetches, LSP downloads, external plugins, sharing and snapshots
are disabled. Repository discovery is disabled in this child so OpenCode does not
write a project-ID cache into `.git` or expand permissions to a parent worktree.
AI inference may still require the user's provider network connection; this is not a promise
that online models work offline. The MCP command uses the shipped
`cocos4-mcp-launch` (Linux) or `cocos4-mcp-launch.exe` (Windows) before the kit's
absolute Node/CLI paths. The Linux helper has no dynamic loader. Both construct
a fixed minimal environment, so provider
secrets and Node/loader injection variables are not inherited by MCP. AI requires
the helper and its verified integrity report; there is no host `env` fallback,
runtime compilation, arbitrary environment assignment or argument passthrough.

Temporary client config/state is removed on normal exit, handled signals and
startup failure. Forced launcher death or machine failure can leave a private
orphan directory; never automatically delete another session's directory. MCP
job/artifact state is separate and retained. Do not assume a killed UI proves all
workers have stopped without checking stdio shutdown evidence.

## Other Clients

Other MCP clients should launch the kit's absolute entrypoint as an argument array:
`["/absolute/path/to/kit/cocos4", "mcp", "--workspace", workspace,
"--state-root", state, "--mode", "read-only"]`. This retains release inventory
verification and the self-locating, environment-filtering launcher. Configure a
minimal child environment before starting it.
On Windows, use the absolute `cocos4.exe` path in that argument array and ordinary
Windows drive paths for workspace and state; no `cmd.exe` wrapper is needed.
Never launch through npm/npx or a shell. MCP stdout must remain protocol-only.
Give the client the entire bundled `skills` directory separately; other clients
are not promised to recognize OpenCode's `skills.paths` setting automatically.
Only edit a persistent client configuration after separate user authorization,
diff review and backup. Then restart that client; running sessions do not reload
configuration. The isolated launcher requires no restart of an existing session.

The source-checkout maintainer CLI is different: an explicitly selected Node runs
`tools/devkit/build/src/cli.js` with `mcp` or `ai` and explicit `--sdk-root`,
`--workspace` and `--state-root`. Its `ai` command also requires `--client opencode`
and an installed `--executable`. These are maintainer instructions, not a portable
launcher command or a replacement for the kit's outer inventory verification.
