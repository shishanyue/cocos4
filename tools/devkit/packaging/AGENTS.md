# Cocos4 导出包：AI 工作指南

本目录是可重定位的离线游戏开发套件，包含预编译引擎、SDK、MCP/CLI 和
游戏开发 skills。你在使用导出包，不是在维护 Cocos 引擎源码仓库。
正常游戏开发不需要安装 Node/npm、下载依赖、运行 postinstall 或重新编译引擎。
先遵循用户的项目要求和已有授权，再按本指南使用包内入口。

## 先读这些文件

所有路径均相对于包含本文件和 `cocos4.exe`（Windows）或 `cocos4`（Linux）的包根目录。

| 路径 | 用途 |
| --- | --- |
| `skills/cocos4-devkit/SKILL.md` | 首先读取：目录、权限、catalog、异步任务和开发流程 |
| `skills/cocos4-minigame-dev/SKILL.md` | 编写玩法时读取：公开 cc API、组件、输入、资源、音频和重开 |
| `skills/cocos4-devkit/references/workflow.md` | 创建、检查、构建、预览与报告的具体约定 |
| `skills/cocos4-devkit/references/client.md` | MCP 客户端接入及可选 OpenCode 适配的边界 |
| `skills/cocos4-minigame-dev/references/runtime.md` | 游戏运行时模式和资源生命周期 |
| `skills/cocos4-minigame-dev/references/delivery.md` | 目标、功能组合及交付验证层次 |
| `docs/getting-started.md` | 安装包入口、宿主要求和命令说明 |
| `release.json`、`sdk/manifest.json` | 当前发行包和内层 SDK 的身份、文件、profiles 与 templates |
| `docs/acceptance.json`、`THIRD_PARTY_NOTICES` | 当前验收范围及许可信息 |

这些 skills 已随包提供，不需要在线安装。客户端未自动发现 `skills/` 时，
直接打开对应 `SKILL.md` 并按需读取其相对引用；不要假定当前会话已经加载了它们。
需要自动发现时，把包内 `skills/` 的绝对路径交给客户端支持的 skill 配置机制。
不要把源码仓库的引擎维护指南当作本包的安装步骤。

## 目录与启动

将安装包视为只读。游戏工作区、私有状态必须在包外，并且三者相互独立，
不能嵌套或通过链接重叠。启动时使用真实、规范的绝对路径。
`project` 等工具参数则使用工作区内的相对路径；`.` 只指已授权的外部工作区根目录。

在本机 Windows 上，把套件、游戏、状态、浏览器配置及临时文件统一放在
受保护的 `D:\cocos4-work` 子目录中；例如 `kit`、`games`、`state` 是同级目录。
不要在 `C:\` 或 `C:\Users\Administrator` 堆放解压包和测试目录。
设置子进程的 `TEMP`、`TMP`、`TMPDIR` 到该工作目录。私有目录的 ACL 应只授予
当前用户、SYSTEM 和 Administrators；不要修改整个磁盘的 ACL。
普通祖先目录的共享写权限、junction、symlink、UNC 和备用数据流可能被拒绝，
应核查具体目录和完整路径，不要关闭校验或切换到 C 盘散放文件。
Linux 使用当前用户拥有的私有目录，遵循本包记录的宿主和文件系统要求。

先从包根执行 `./cocos4 doctor` 或 `./cocos4.exe doctor`。
不带 `--workspace` 的 doctor 只检查包、SDK 和宿主，不创建游戏或私有状态。
其他命令明确传入外部 `--workspace` 和 `--state-root`，避免使用包目录这个当前工作区。
统一通过外层启动器访问 SDK；它已固定 `sdk/`，不要传 `--sdk-root`。
不要直接启动 `app/src/cli.js`、运行包内 npm scripts 或修改 `sdk/`、`app/`、
`runtime/`、`skills/`、声明和 `release.json`；这些文件由摘要和来源记录绑定。

## MCP 接入和 CLI 备用入口

先检查当前 AI 会话实际可调用的工具。能读取本文件、skills 或启动 CLI，
不代表 MCP 已接入该会话。已有 MCP 时，用客户端的 tools/list 检查实时 schema；
工具名前缀可能由客户端添加，参数和输出以服务实际声明为准。

兼容客户端可把下面的通用进程字段接入其 MCP 配置；按真实安装路径和客户端
格式调整。使用命令与参数数组，不经过 npm/npx、cmd.exe 或 shell 包装：

```json
{
  "command": "D:\\cocos4-work\\kit\\cocos4.exe",
  "args": [
    "mcp", "--workspace", "D:\\cocos4-work\\games",
    "--state-root", "D:\\cocos4-work\\state",
    "--mode", "develop", "--preview", "true"
  ]
}
```

Linux 改用实际 `cocos4` 的绝对路径和 Linux 路径。工作区须预先存在；状态路径
由服务管理，不能位于工作区或包内。服务 stdout 是 MCP 协议通道，不能混入日志。
启动服务进程本身不会给当前会话增加工具；需通过客户端已有的 MCP 接入机制连接。
持久客户端配置只在用户已授权的范围内修改，提供可检查的变更并按需重启客户端。

没有已连接 MCP 时，如果用户已授权宿主命令工具，使用同一启动器的 CLI 完成工作。
下面是 Windows PowerShell 的起点；`$kitExe` 根据实际包根设置：

```powershell
$kitExe = Join-Path (Get-Location).Path 'cocos4.exe'
$gameWorkspace = 'D:\cocos4-work\games'
$gameState = 'D:\cocos4-work\state'
& $kitExe tools --workspace $gameWorkspace --state-root $gameState --mode develop --preview true
& $kitExe call cocos4_catalog --input '{"section":"profiles","limit":100}' --workspace $gameWorkspace --state-root $gameState
```

CLI 的通式是 `cocos4.exe call TOOL --input JSON --workspace ABSOLUTE
--state-root ABSOLUTE --mode develop`；预览另加 `--preview true`。
只读查询可省略 develop。CLI 会等待异步任务并输出结构化 JSON 行；预览命令
在公布 URL 后保持运行，直至 TTL 或关闭。不要为读取一次输出就提前杀死预览。
Linux 使用 `cocos4` 的等价命令。OpenCode 是可选参考客户端，MCP/CLI 可独立运行。
`ai --client opencode` 要求已安装且受支持的客户端和显式 `--executable`；
它不会安装客户端。Windows OpenCode/Bun 的受保护工具模块加载尚未验收，
不要为迁就它放宽保护，也不要把其模型账号作为普通游戏开发的前提。

## 游戏开发闭环

1. 用 `cocos4_catalog` 分别查询 `sdk`、`profiles`、`templates`，记录 `sdkId`、
   目标、profile、variant 和真实 `templateId`。实际交付能力由这些结果决定；
   不假定每个包都有四目标或十六组 profile。
2. 已有项目先调用 `cocos4_project_inspect`。新项目在用户授权的外部工作区内，
   用 `cocos4_project_create` 的 `directory`、`projectName`、`templateId` 和
   新 `requestKey` 创建不存在的相对目录，不覆盖旧项目。
3. 通过客户端已授权的文件工具修改游戏文件。MCP 不是通用文件写入器；
   受限 OpenCode 会话使用其 `cocos4_read`、`cocos4_write`、`cocos4_edit`、
   `cocos4_apply_patch` 工具。
   沿用随包模板的代码场景、资源和加载器，保持规则与组件表现分离。
4. 游戏代码从公开 `cc` 导入，先用 `cocos4_docs_search` / `cocos4_docs_read`
   查真实 API 与模板例子。不导入引擎内部目录。检查 profile 的 features；
   声明或同名导出不能证明某个功能的运行时已交付，例如基础 2D profile
   不含独立 Graphics 绘图模块时应使用已有 Sprite/Label 或选择合适的交付组合。
5. 调用 `cocos4_project_check`，选择实际 `target`、`profile` 和 `checks:["types"]`。
   修复真实诊断后重新检查，不能用空声明、any 扩散或跳过库检查掩盖依赖问题。
6. 调用 `cocos4_game_build`，明确 `target`、`profile`、`variant` 和新 `requestKey`。
   保存新产物的 `artifactId`、摘要、SDK/profile 和发行来源；改过代码后重新构建。
7. HTML5 产物可用 `cocos4_preview_start` 预览，输入 `artifactId`、新 `requestKey`
   和 `ttlSeconds`。等 `job.phase === "ready"` 再打开实际 URL；结束后用
   `cocos4_preview_stop` 的 `jobId` 停止。验证画面、输入、资源、音频、胜负和重开。
   小游戏源码包不支持这条浏览器预览路径。

WECHAT/BYTEDANCE 使用项目 `platforms/wechat` 或 `platforms/bytedance` 下的
`game.json` 和 `project.config.json`；使用用户提供的真实 appid，缺少时区分本地
测试配置和可发布配置。BILIBILI 使用项目根 `game.json`。这些配置属于游戏，
不能用 SDK 验证配置替代，也不能把本地源码预检说成厂商编译、上传或真机渲染。
此分支保留 2D/3D、小游戏和浏览器开发，不支持 APK/IPA/桌面原生应用或 JSB。
`NATIVE`、`JSB` 不可启用；资源 `native/`、`nativeAsset`、WASM/ASM.js 则是合法资源概念。

## 权限、任务和交付

默认 read-only；创建、检查和构建需要启动时 `--mode develop`，预览另需
`--preview true`。逻辑测试通过 project_check 的 `checks:["logic"]` 发起，另需
用户已授权的 `--execute-tests true`；它执行可信代码，不是沙箱。
工具参数不能提高启动权限。延续会话已有授权，正常读查、可逆游戏编辑和已授权
构建直接推进；不要反复询问。缺少明确的项目位置或关键玩法要求时才澄清。

MCP 的异步调用先返回 receipt，随后用 `cocos4_job_get` 轮询同一 `jobId`。
只以终态 `job.state === "succeeded"` 和无失败诊断作为成功，不能把外层 `ok`
或 running/ready 当作构建通过。检查报告所有 `nextCursor` 页；用
`cocos4_job_logs` 查日志，`cocos4_jobs_list` 查任务，`cocos4_job_cancel` 取消任务。
相同 requestKey 用于去重，不是重新构建；改变输入或重试修复后使用新 key。

报告实际完成的检查、源码变更、产物身份、可用的预览 URL及关闭状态，分别说明
类型/逻辑、游戏构建、真实浏览器、厂商和设备层次。依据当前报告与
`docs/acceptance.json` 描述限制，不能移用旧包身份或把历史测试变成本次通过。
用户未要求上传、账户操作或正式发布时，完成本地可检查的游戏和产物即可。
