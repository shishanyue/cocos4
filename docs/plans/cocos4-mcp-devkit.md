# Cocos4 MCP 与便携开发套件

状态：开发 MCP、离线 SDK、v5 产物来源记录与 Linux 候选包已实现，完整发行验收仍在进行中；当前两版本全量矩阵尚未通过。

初稿仅形成计划；后续已新增独立工具包、锁定依赖、离线 SDK、授权逻辑测试、临时 OpenCode 接入和本地便携候选包。候选包未获准再分发，真实模型闭环与多宿主验收未完成。
调研基线为分支 `v4.0.0`、引擎 `4.0.0-alpha.34`、提交 `2736376eb7`。
下文为完整产品契约，不能全部视为已实现；当前默认十个工具、develop 模式十三个工具、另开 preview 权限十五个工具，入口见 [MCP 说明](../../tools/devkit/MCP.md)。
逐项契约、实际证据与未完成项见 [验收清单](../../tools/devkit/ACCEPTANCE.md)；历史 P0 记录仍保留在 [工具说明](../../tools/devkit/README.md)。
新增 [Effect 验证记录](../../tools/devkit/effects/README.md)：2D/3D builtin 资源已通过严格编译；条件分支问题已修复，没有跳过 parser 或真实 GL 检查。

## 1. 目标与边界

交付面向当前 Cocos4 fork 的独立 MCP，以及包含它的便携游戏开发套件。
普通用户下载对应操作系统的发布包、解压、连接已有 AI 客户端，即可开发、检查、
预览游戏；不要求克隆引擎、不要求 Creator，也不要求安装 Node/npm 或编译引擎。
不能把“将几个源码仓库 npm 命令包装成 MCP”作为此目标的完成标准。

### 必须满足

- 维护者在发布流水线编译引擎和工具；用户只使用预编译程序及其完整运行依赖。
- 一个离线发布包包含 MCP、CLI、宿主运行时、引擎功能组合、声明、运行资源、文档、
  游戏开发 skills 和可运行示例。正常首次使用不触发依赖下载或 `postinstall`。
- 保留 2D/3D。首版必须分别完成一个可交互的 2D 和 3D 浏览器示例，而非只有空白画布。
- 游戏开发使用公开 `cc` API；支持普通 TS/JS 代码和标准资源文件，不研发编辑器，
  不发明替代 Creator 的场景格式、UUID 体系或新的专有游戏项目格式。
- 引擎构建、游戏代码构建、完整游戏产物组装、厂商编译打包、上传和真机验证分别报告。
- 源码维护能力为可选扩展，不成为普通游戏开发者的隐式前置条件。

### 不在首版范围

- Creator 内部场景操作、Inspector 控制、任意 `.scene`/`.prefab` 项目的无损导入导出。
- 通用美术资源导入器、FBX 转换、完整自定义 Effect 编辑和任意第三方构建插件。
- 厂商账号登录、签名、支付、上传、审核自动化，以及 B 站开发工具的 MCP。
- 自动安装 AI 客户端、托管模型或附赠模型账号。用户仍需可用的 MCP 客户端、模型
  访问能力和浏览器；AI 推理的联网需求与本套件的离线运行能力分开说明。
- 远程多租户 MCP、HTTP MCP 服务、通用 shell/eval 工具和自动更新守护进程。
- 原生应用后端、JSB、原生模拟器、原生 SDK 或引擎根目录 `native/`。

发布包内的 Node 可执行程序、必要的宿主工具不等于恢复原生应用发布。
`NATIVE`、`JSB` 始终为 false；资源 `native/`、`nativeAsset`、WASM/ASM.js 等合法
共享能力继续保留。平台白名单仍以 `cc.config.json.platforms` 为准。

## 2. 现状与缺口

| 已有入口 | 实际能力与副作用 | 规划中的复用方式 |
| --- | --- | --- |
| `cc.config.json`、ccbuild `StatsQuery` | 平台、features、依赖及编译常量的权威来源 | 发布时生成带版本和摘要的能力清单，不能维护第二份手写平台列表 |
| `scripts/build-minigame.cjs` | 仅接收平台和逗号分隔 feature 列表；先类型检查；输出固定目录 | 维护者构建复用现有 CLI；发布流水线提取最小公共入口，不给现有 CLI 强塞新参数 |
| `scripts/build-h5-source.js` | HTML5、BUILD、SystemJS；清空 `bin/dev/cc`；不是预览服务器 | 参考引擎构建契约，另行实现套件的游戏预览服务 |
| `scripts/build-declarations.js` | 清空并生成 `bin/.declarations`，包含真实 WebGPU 类型及声明消费者检查 | 将公共 API 声明的完整依赖闭包随包发布，不要求用户本地重新生成 |
| `scripts/validate-bilibili.cjs` | 导出只读 `validateBilibili(directory)`，检查完整游戏目录 | 直接复用并在 worker 中执行；MCP 层额外限制授权路径和扫描预算 |
| `prepare:engine` | 补丁校验、生成 PAL/adapter、调试信息和常量，会写生成目录和依赖 | 仅维护者显式操作，不由诊断或普通开发模式隐式触发 |
| `setup:external` | 准备 `external/emscripten`；无本地 source 时联网获取制品 | 只在维护者发布准备阶段执行；用户发布包必须已包含所需运行资源 |
| `templates/launcher/`、`templates/bilibili/` | 启动模板依赖 settings、模块加载器、import map 和游戏脚本 | 复用契约并补齐独立组装链路；模板本身不是完整游戏导出器 |
| `.opencode/skills/cocos4-minigame-dev/` | 有公共 API 规则和示例，但定位、声明检查、创建项目仍依赖源码/Creator | 改为识别发布包与现有 Creator 项目两条实际工作流，再做便携验收 |

当前 `build:minigame` 的默认 features 为
`base,2d,ui,audio,tween,gfx-webgl,gfx-webgl2`；显式列表会替换默认值。
输出为未压缩、有 source map 的 SystemJS 引擎模块，固定在
`bin/minigame/<platform>/`。连续构建可能残留旧文件，不能直接作为干净的发布目录。

初始盘点时没有独立游戏编译器或游戏预览服务器。当前已实现 SDK 内游戏编译、标准图片/JSON/音频资源组装、受限 HTML5 预览，以及真实 BILIBILI profile 的源码包组装和本地预检；完整 Creator 资源导入、厂商编译和真机验收仍未实现。
`cocos/game/game.ts` 初始化还涉及 settings、builtin assets、渲染管线、脚本包和启动场景；
仅复制一个 `cc.js` 并调用 `game.run()` 不能证明游戏可用。
现有 skills 的平台表也需由新能力清单校验，包括已经加入引擎的 BILIBILI。

## 3. 核心决策

### 3.1 发布形态

发布 `cocos4-devkit-<kit-version>-<os>-<arch>` 压缩包，采用“内置 Node + 编译后的
JS 程序 + 已准备好的运行依赖”，不将单文件可执行封装作为首版前置条件。
JS 是可直接执行的构建制品，并不意味着把引擎 TS 源码仓库换个名字放进压缩包。
用户编译的是自己编写的游戏代码，不是 Cocos4 引擎。

首批宿主目标为 Linux x64、Windows x64、macOS arm64。逐个完成实际宿主验收后才
提供对应下载；macOS x64、Linux arm64 等后续增加，不用“跨平台 JS”代替宿主测试。
各包标注真实最低 OS/libc 要求、CPU 架构、签名状态及已验证客户端版本。

拟定发布目录：

当前候选布局将下述引擎、toolchain、catalog、templates 等原 SDK 内容保留在 `sdk/`，
外层 `release.json` 包含宿主 Node、应用、skills 和发行文件清单；不修改内层 SDK 摘要。

```text
cocos4-devkit/
  cocos4 / cocos4.cmd
  runtime/                    # 对应宿主的 Node 及必要运行库
  app/                        # 编译后的 CLI、MCP、worker 和固定依赖
  toolchain/                  # 游戏 TS 编译器、模块处理工具及标准库
  engine/
    profiles/<target>/<profile>/<variant>/
    types/                    # cc.d.ts、webGPU.d.ts 及实际引用闭包
    runtime-assets/           # builtin、shader、选中功能所需 WASM/ASM.js
  catalog/                    # 平台、features、profiles、API 索引
  skills/
    cocos4-devkit/
    cocos4-minigame-dev/
  templates/                  # 标准 TS/JS 代码项目的可运行起点
  examples/
  docs/
  manifest.json
  LICENSE
  THIRD_PARTY_NOTICES
  SBOM.spdx.json
```

发布包不得包含引擎 `.git/`、`cocos/`、`exports/`、生成 PAL 工作树、整个开发用
`node_modules` 或编辑器缓存。允许公开声明、示例游戏 TS、运行 JS 和必须的原始资源。
普通发布包不内嵌引擎源码到 source map；调试符号可作为独立可选制品，不影响开箱使用。
复制文件采用发行白名单和依赖闭包校验，而不是对工作目录整体打包。

### 3.2 版本与工具链

| 对象 | 首版选择与验证约束 |
| --- | --- |
| 引擎源码基线 | 保持 Node `>=18`、TypeScript `4.9.5` 的既有检查，不因本机 Node 版本而提升最低版本 |
| 引擎依赖 | 保持 ccbuild `2.3.21`、tfig `3.3.4`、PAL `1.0.4`、platforms `1.0.6`；升级另行评审补丁 |
| MCP SDK | 已锁定 `@modelcontextprotocol/sdk@1.30.0`；stdio、严格错误路由、固定能力声明和开发工具已接通官方客户端黑盒验证 |
| MCP 类型工具链 | 独立 tsconfig/lockfile；TS `5.9.3`、Zod `3.25.76` 严格检查已通过，隔离于引擎 TS 4.9.5，不关闭库检查 |
| 游戏类型检查 | 随包携带 TS `4.9.5` 和真实 `cc` 声明；装饰器、字段初始化、模块转换与引擎契约做实际运行对照 |
| 发布包运行时 | 随包携带受维护的 Node LTS，首选 Node 24 系列；发布时锁定具体补丁、来源和 SHA-256，不依赖用户 PATH 上的 Node |
| external | 以 `external-config.json` 的 `cocos/cocos-engine-external@v4.0.0-9` 为当前基线，记录实际内容摘要和许可证 |

SDK 类型组合及加载器探针已在 Linux x64、Node `18.20.8` 和 `24.21.0` 验证；私有探针包
最低版本明确为 `18.20.8`，不改变引擎的 `>=18`，也不代表更早 Node 18 补丁已经验收。
SDK 允许的 Hono node-server 2.x 需要 Node 20，故在独立包内锁定其同样允许的 `1.19.9`；
没有修改依赖源码、升级根 TypeScript 或弱化检查。已在真实浏览器验证模板的装饰器、类字段与修改后的玩法；这不保证任意游戏代码都正确。
不选择要求 Node `>=20` 的 SDK 2.x 作为首版默认，也不运行 `npx ...@latest`。
新的工具源码不在根 `tsconfig.json` 的默认 include 中，必须有明确的独立检查、构建和测试入口。
工具服务按 Node 18 API 基线开发，并在最低版本和随包 Node 上分别验证；内置较新的
安全维护版本不等于提高引擎源码的最低环境要求。

### 3.3 预编译 profiles

平台和 features 不是运行时开关。发布流水线为每个组合分别构建，用户只选已经随包
交付的 profile，不能在无源码环境承诺任意 feature 组合重新裁剪。

| 拟定 profile | 构成 | 首版目标 |
| --- | --- | --- |
| `2d-basic` | base/2d/ui/audio/tween/WebGL1/2，显式加入 legacy-pipeline | 2D 交互、UI、图片、音效和重开 |
| `3d-basic` | `2d-basic` 加 3d/animation/skeletal-animation/primitive | 3D 场景、相机、网格、基本材质和 UI；不默认承诺物理 |
| 后续可选包 | 明确选择的 2D/3D 物理、Spine 等 | 单独验证体积、运行资源、许可证和平台能力，不能只加声明 |

P0 源码追踪发现现有 smoke 默认 features 不注册渲染管线，不能直接作为可玩 profile。
首个独立验证采用 legacy forward pipeline，避免额外的 custom-pipeline layout graph
生产依赖；builtin Effect/材质仍需独立编译，不能用 headless fixture 代替。

优先交付 HTML5 浏览器预览、BILIBILI 的独立组合；WECHAT、OPPO 必须继续通过源码侧
引擎回归。其他平台的 portable profile/exporter 按验收逐个加入，不因白名单存在就宣称可导出。
`debug` 与 `release` 分别记录压缩、source map、编译常量和文件摘要；发布生成器需要
干净 staging 及 release 构建入口，不能把当前 smoke CLI 的输出误称为生产优化包。

清单必须分别表达 `engineTargetAllowed`、`prebuiltAvailable`、`exportAvailable`、
`validationLevels`。BILIBILI 与 WECHAT 必须使用各自常量和 PAL，不能重命名同一 bundle。
包含 WebGL2 模块不等于 B 站已启用 WebGL2；启用时仍需四个高性能配置及真实容器验证。
缺少 profile 返回 `PROFILE_NOT_AVAILABLE`，列出可用组合或可选离线包，不自动下载源码。
独立浏览器预览采用 HTML5 的 BUILD 模式，debug 变体也不启用 Creator 的 PREVIEW/EDITOR
常量；否则 `game.ts` 会进入 `cce:/internal/x/prerequisite-imports` 等编辑器专用加载路径。

### 3.4 可追溯发行

`manifest.json` 至少记录 kit/engine 版本、源码 revision、清单 schema 版本、MCP 工具契约
版本、宿主平台、运行时及工具依赖版本、profile/features/常量、模块格式、资源闭包、
文件大小/摘要、skills/API 版本、许可证和各层验收证据索引。
单独发布归档校验和、签名或可验证的构建证明；不能用随包同放的哈希冒充来源认证。

发布从干净工作区、锁文件和固定 external 生成，禁止抓取维护者现有 `bin/` 缓存作为
正式输入。归档统一排序和非必要时间戳；相同输入的未签名 payload 应可复现，签名或
平台元数据的差异单独说明。升级采用旁路解压新版本，默认不原地替换运行中的 SDK。
项目产物记录使用的 kit/profile 摘要；不同版本的缓存不能混用。

当前实现从执行中的应用验证外层 `release.json`，新 job 记录 `releaseId`，新产物的
receipt/inventory 记录 `provenance: { releaseId, profileSha256 }`；profile 摘要取实际
选中 descriptor 的清单 SHA-256，并与报告及发布上下文核对。源码工具的 `releaseId`
为 `null`，不能冒充某个发行包。v2/v3/v4 导入不得补造原本缺失的发行或 profile 来源；
历史 job 的默认 null 也不能证明其由源码工具产生。完整性绑定仍不等于发布者认证。

## 4. 无 Creator 游戏闭环

### 4.1 必须先完成的技术验证

在扩大 MCP 工具数量之前，使用与最终发行相同的布局，移除源码路径和开发机依赖，
验证以下链路。缺少任何一项都不得把“解压即开发”标记完成。

1. 独立模块加载器与 import map 能加载当前 SystemJS 引擎和游戏模块。
   校验小游戏 `System.warmup` 所需实现及其可再分发来源，不能用不兼容的通用加载器替代。
2. 通过真实 `game.init`、settings、builtin assets 和渲染管线完成首帧。
   查清 `cc.config.json` 的 dependentAssets、内置 Effect/材质及字体如何构建和发布。
3. builtin/shader 数据通过可维护、可再分发的独立构建过程生成，不依赖 Creator 可执行文件、
   某台机器的 `editor/library` 或私人缓存；测试 fixture 不能直接充当生产资源管线。
4. 普通 TS 中的 `cc` 导入、装饰器和类字段行为与实际引擎一致，小游戏模块转换正确。
   类型检查通过还需验证运行行为，不能只用无装饰器的纯逻辑示例过关。
5. 2D/3D 示例在真实浏览器绘制、接受输入，并加载本地图片、JSON、音频及需要的运行资源。
   验证失败加载、音频首手势和场景重开，不用 jsdom 或 gfx-empty 代替图形验收。
6. 将同一游戏组装成 BILIBILI 目录，补齐 bootstrap、settings、脚本、adapter 和资源，
   再进行本地预检；代码创建场景也要验证首场景绘制后只上报一次 launchSuccess，
   启动失败不应上报。真实厂商编译和真机另设验收。

若独立 shader/builtin 生产链无法闭合，应记录具体缺失依赖及许可证问题，先补齐独立
工具链或调整经用户批准的范围；不得暗中引入 Creator，也不能只交付 MCP 外壳。

### 4.2 游戏项目约定

新示例采用常规 `package.json`、`tsconfig.json`、`src/main.ts`、`assets/` 和 `tests/`
目录。首版使用代码创建 `Scene`、`Node`、UI 和基本 3D 对象，不要求编辑器序列化文件。
这是可修改的示例布局，不是强制的新引擎项目格式；已有项目先检查，不能覆写其配置。
构建目标/profile 从 CLI/MCP 的参数选择，生成 settings/import map 使用现有运行时格式。

- 游戏代码通过公开 API 加载首版明确支持的图片、JSON、音频等文件；URL 与包内路径
  转换由统一构建逻辑处理。记录支持的文件扩展名、编码和错误路径，不接受未知格式后静默复制。
- 首版不把 FBX、任意 Effect、Creator 原始 `.scene`/`.prefab`、纹理压缩和资源 UUID
  转换伪装成普通文件复制。检测到需要未实现导入器的项目返回明确诊断。
- 同包提供不需要第三方 npm 依赖的可玩模板。游戏后续新增依赖属于显式流程，默认构建
  不安装依赖、不执行 `package.json` scripts，不自动载入项目的 Babel/构建插件。
- API 索引同时给出声明和 profile 可用性。全量 `cc.d.ts` 中存在的 API 不代表当前
  bundle 已包含它；对命名导入进行链接检查，并以运行测试补充动态使用的检查边界。
- 检查、构建、预览、导出共用一套应用层逻辑，CLI 和 MCP 不各自维护不同规则。
- 输出放在 SDK 管理的项目产物目录，按 artifact ID 隔离；不覆盖源代码、用户资源或
  非本工具拥有的构建目录。仅复制选中平台/profile 的运行闭包，不把整个 SDK 放入游戏包。

## 5. 用户流程

以下命令在对应候选包的解压目录运行，不是引擎仓库根目录的命令；正式下载和发行验收尚未完成：

```sh
./cocos4 doctor
./cocos4 ai --client opencode --executable "/absolute/path/to/opencode" --workspace "/absolute/path/to/games"
./cocos4 mcp --workspace "/absolute/path/to/games" --mode read-only
```

当前 portable `./cocos4 doctor` 未指定 `--workspace` 时只验证发行清单、SDK 与宿主读取
能力，不需要或创建 workspace、`HOME`、XDG 状态配置或私有 state，也不把当前目录
当游戏扫描。输出为一个 `scope: "sdk-only"` 的 JSON 报告，包含 release/SDK ID；
它不检查或启动 AI 客户端，不运行项目代码。显式 `--workspace` 保留原 worker/job 流程，
状态默认位于 `$XDG_STATE_HOME/cocos4` 或 `$HOME/.local/state/cocos4`，可用外部
`--state-root` 指定。无 workspace 时拒绝 state 参数和执行授权，而非静默忽略。
portable `ai` 必须显式提供已安装客户端的 `--executable`；启动器固定本包 SDK，拒绝
`--sdk-root`。源码 CLI 的三个显式根参数要求不变，不能与 portable 命令混写。

1. 用户选择与宿主匹配的发布包，验证发布来源并解压；启动器从自身位置定位 SDK，
   不依赖原始安装路径、当前目录或系统 Node。SDK 可只读，状态和游戏项目放在外部目录。
2. 诊断区分包损坏、宿主不兼容、profile 缺失、AI 客户端缺失和游戏配置问题。
   SDK-only `doctor` 只覆盖包和宿主读取检查；工作区诊断走显式 workspace 的 job 流程，
   客户端存在性和版本检查由 `ai` 启动流程执行。没有 Creator 或引擎 checkout 不是
   portable 模式错误，不运行准备或下载命令“修复”。
3. `ai` 为已安装的 OpenCode 启动新会话，在用户明确选择工作区和权限后，通过子进程
   临时配置接入本地 stdio MCP 和随包 skills；默认不修改用户全局配置或全局 skills。
4. AI 查询能力及示例，创建新游戏，编辑普通游戏代码，执行检查和构建，开启本地预览，
   根据结构化诊断迭代。修改代码由 AI 客户端自己的文件工具完成，不扩展成 MCP 任意文件写入。
5. 用户显式选择 BILIBILI 等已支持的导出目标后生成完整目录并预检。厂商工具及账号
   未准备时，只报告目录和剩余步骤，不将其描述为已经发布或已通过真机验收。

OpenCode 接入须依照当前 `https://opencode.ai/config.json` 校验：`mcp` 为对象，
本地条目用 `type: local` 和参数数组 `command`，skills 使用 `skills.paths`。
拟用 `OPENCODE_CONFIG` 指向本工具拥有的临时配置，仅作用于新客户端子进程；已有的
环境配置或同名 MCP/skill 冲突须展示并处理，不覆盖无关设置。实现时冻结支持的客户端
版本和 schema，在发行包内携带验证所需信息，不要求用户联网获取 schema 才能启动。

当前 Linux x64 的 AI 子 MCP 由随包 `cocos4-mcp-launch` 启动。它使用 `static-no-libc`
链接，无 ELF interpreter 或共享库，在 Node 启动前构造固定命令和清理后的环境，消除
运行时 `/usr/bin/env` 依赖，不回退到宿主 env 命令。Node 和其他辅助程序自身的 libc
要求不因此消失；独立的 OpenCode/provider 认证环境仍按原边界保留，不传入 MCP。

为其他客户端提供准确的 stdio 启动命令和完整 skills 目录，但不承诺其自动识别 OpenCode
配置。需要持久配置时先预览差异，再经用户授权写入项目配置并备份；配置/skills 改动后
提示退出并重启客户端。当前实现只为新客户端子进程创建临时接入，不默认生成持久配置。

## 6. MCP 契约

### 6.1 协议与能力

- 首版采用本地 stdio，按 MCP `2025-11-25` 规范实现和协商版本；只宣称 SDK 与实际客户端
  集成测试通过的协议版本，不手写 JSON-RPC，也不做未经验证的旧协议兼容。
- `stdout` 仅输出 MCP 消息。启动提示、依赖日志和子进程 stdout/stderr 必须捕获到受控日志，
  服务诊断写 `stderr`，禁止 `stdio: inherit` 污染协议通道。
- 首版提供 tools 和只读 resources。工具列表在启动时按权限模式固定，不虚报 listChanged、
  资源订阅、prompts、sampling、elicitation 或实验 Tasks 能力。
- 长任务使用普通 tools 的 job 契约，不能假定 OpenCode 支持实验 Tasks。未来只有在规范
  稳定和客户端验证后才增加映射，不以实验 Tasks 阻断普通 `tools/call` 客户端。
- resources 使用版本化 `cocos4://sdk/<sdk-id>/...` URI，暴露清单、文档和示例，不开放任意
  `file://` 读取。docs tools 提供同等入口，客户端不支持 resources 也能完成工作流。
- 工具提供准确的 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`；
  这些只是说明，不是权限校验。运行代码、写产物和监听端口不能标成无副作用查询。

### 6.2 通用 Schema

每个工具必须有 JSON Schema `inputSchema` 和 `outputSchema`；对象拒绝未知属性，
枚举来自服务加载的已验证清单。下表中的 `?` 表示可选，不是允许任意字段。

| 通用类型 | 约束 |
| --- | --- |
| `RelPath` | 相对启动时授权 workspace 的路径；禁止绝对路径、上跳、URI、NUL、跨盘及符号链接逃逸 |
| `Project` | workspace 内已验证项目的 `RelPath`，不是任意 cwd；默认值只在工具说明中明确提供 |
| `Id` | 服务或清单签发的有长度上限标识符；不能把 ID 当文件路径拼接 |
| `Page` | opaque cursor；limit 默认 20、范围 1..100；cursor 绑定查询条件和清单版本 |
| `RequestKey` | 创建写入/执行任务时必填，匹配 `[A-Za-z0-9._-]{1,128}`；只读扫描和幂等取消除外；用于有期限的去重，不是授权凭证 |
| `Timeout` | 毫秒整数，只能在该操作预设上限内选择，不能由调用方设置无限期 |
| `Diagnostic` | code、severity、message、相对 file/line/column（若有）、来源和可操作 nextSteps；不含任意待执行命令 |

所有响应的 `structuredContent` 为统一信封：`schemaVersion: 1`、`sdkId`、布尔 `ok`、
工具特定 `data`、`warnings: Diagnostic[]`、可为 null 的 `error`。
同时在 text content 返回同一 JSON 的序列化，兼容只展示文本的
客户端。结果结构按工具固定，不能返回一个未经解析的大段终端输出冒充结构化诊断。
较大数据分页，单次完整响应预算 64 KiB，包含重复的 text/structured 部分；按实际序列化
UTF-8 字节数限制，不能截断 JSON。终态报告中的诊断和产物列表也必须可分页获取。

协议结构错误、未知方法/工具走 JSON-RPC 错误；工具参数的业务校验及执行失败用
`isError: true` 和 `ok: false`。`error` 包含稳定 code、message、retryable 和 nextSteps。
至少定义 `PERMISSION_DENIED`、`PATH_OUTSIDE_WORKSPACE`、`SDK_INCOMPLETE`、
`PROFILE_NOT_AVAILABLE`、`FEATURE_NOT_IN_PROFILE`、`UNSUPPORTED_PROJECT`、
`OUTPUT_CONFLICT`、`INPUT_CHANGED`、`TIMEOUT`、`CANCELLED`、`PROCESS_FAILED`、
`ARTIFACT_INVALID`。不依据零退出码或已有旧目录单独判定成功。

### 6.3 首版工具

| 工具 | 主要输入 | data 或 job 最终结果 | 权限/副作用 |
| --- | --- | --- | --- |
| `cocos4_catalog` | section: sdk/platforms/features/profiles/templates；target?；cursor?；limit? | 版本、能力记录、支持层次、nextCursor | 只读，离线 |
| `cocos4_docs_search` | query（1..256 字符）；kind: api/guide/example/all；profile?；分页 | 文档 ID、版本、摘要、匹配位置、API 所需 features | 只读，不做网络搜索 |
| `cocos4_docs_read` | documentId；cursor?；maxBytes? | 最多 16 KiB 的版本化文档内容与 nextCursor | 只读，仅清单内文档 |
| `cocos4_doctor` | project?；depth: quick/full | JobReceipt；最终检查列表、缺失项及修复建议 | 对 SDK/项目只读；全量扫描可取消 |
| `cocos4_project_inspect` | project | 项目类型、入口、所需 features、可选 profiles、资源与不支持项 | 有界只读，不执行项目配置 |
| `cocos4_project_create` | directory；templateId；projectName；requestKey | JobReceipt；最终新文件清单和项目位置 | develop；只创建不存在的目录 |
| `cocos4_project_check` | project；target；profile；checks: types/logic 的非空去重数组；requestKey；timeoutMs? | JobReceipt；最终类型诊断、逻辑测试结果、使用的 profile | develop；logic 另需执行项目代码授权 |
| `cocos4_game_build` | project；target；profile；variant: debug/release；requestKey；timeoutMs? | JobReceipt；最终 artifactId、大小/摘要、诊断和验证层次 | develop；编译游戏及组装产物，不编译引擎 |
| `cocos4_preview_start` | artifactId；requestKey；ttlSeconds? | JobReceipt；ready 后给本机 URL、端口、过期时间 | develop + preview；只服务已完成 HTML5 产物 |
| `cocos4_package_validate` | target（首版 BILIBILI）；directory | JobReceipt；最终文件检查、包大小与 warnings | 对包目录只读；不会修复或上传 |
| `cocos4_jobs_list` | project?；cursor?；limit? | 当前用户/workspace 范围的 job 摘要 | 只读，不能列出其他工作区任务 |
| `cocos4_job_get` | jobId；终态报告 cursor?、limit? | Job 状态、阶段、最终报告和 artifact 列表 | 只读 |
| `cocos4_job_logs` | jobId；cursor?；maxBytes? | 分页日志、nextCursor、截断标记 | 只读；默认 8 KiB，最大 16 KiB |
| `cocos4_job_cancel` | jobId | 当前状态及取消是否被接受 | 仅有权限管理的任务；不接收 PID |

`project_check` 的 logic 只运行约定的纯逻辑测试，不把 NODEJS 引擎 smoke bundle 当成
完整无头游戏运行器。类型诊断和逻辑测试不得替代浏览器渲染验证。
只读模式可写工具自有、有上限的任务元数据和日志，但不得写 SDK 或游戏项目。
`project_inspect` 扫描超过预算时返回范围受限的诊断，引导显式 full doctor，不无限阻塞控制通道。

`game_build` 的核心输入示意如下；实施时从同一 schema 同步生成 CLI 校验和工具文档：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["project", "target", "profile", "variant", "requestKey"],
  "properties": {
    "project": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "target": { "type": "string", "enum": ["HTML5", "BILIBILI"] },
    "profile": { "type": "string", "enum": ["2d-basic", "3d-basic"] },
    "variant": { "type": "string", "enum": ["debug", "release"] },
    "requestKey": { "type": "string", "minLength": 1, "maxLength": 128 },
    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 3600000 }
  }
}
```

示意枚举不是另一个平台白名单，实际值必须取当前发行包已交付的组合；组合本身还需
交叉校验。业务层继续检查路径及 RequestKey 字符范围，Schema 的 string 类型不构成安全保证。

### 6.4 可选源码维护扩展

仅用户显式指定可信 `engine-root` 并启用 maintainer 模式时开放，不在普通 portable
模式展示“需要源码”的工具。首版用户闭环不能依赖本扩展完成。

| 拟定工具 | 受限输入与现有入口 |
| --- | --- |
| `cocos4_engine_build` | platform、可选去重 features、requestKey；以 `process.execPath` 启动 `scripts/build-minigame.cjs`，只传其现有两个位置参数 |
| `cocos4_engine_verify` | suite 枚举 platforms/declarations/dts/unit、requestKey；分别对应 `npm run test:platforms`、`npm run build:declaration`、`npm run test:dts`、`npm test -- --runInBand` |
| `cocos4_engine_prepare` | 单独的 prepare 权限和 requestKey；执行 `npm run prepare:engine`，列明所有生成目录副作用 |

构建脚本末尾会调用 `main()`，不能直接 require 当纯函数。平台/features 分别由配置和
`StatsQuery.create(engine).getFeatures()` 校验；HTML5/NODEJS 不能传给小游戏 CLI。
不接受额外 ccbuild flags、任意输出目录、任意 npm scripts，也不暴露 `npm run clear`、
依赖安装和 external 下载工具。需要维护者人工准备时给出事实诊断。

## 7. 任务与产物

普通 tools 启动作业后立即返回 `JobReceipt { jobId, state, pollAfterMs }`。
receipt 只表示已接受，不能写成“构建成功”。Job 至少记录 operation、project、输入摘要、
phase、时间、deadline、状态、退出码/signal、诊断、artifact IDs、日志 cursor 及错误。
`job_get` 查询成功的外层 `ok` 不代表内部 job 成功，调用方必须读取 state 和最终报告。

```text
queued -> running | failed | cancelled | timed_out | interrupted
running -> succeeded | failed | cancelled | timed_out | interrupted
running -> cancelling -> cancelled | timed_out | interrupted
```

取消、超时、退出竞争必须有唯一终态；接受取消后不能再晋升为 succeeded。
preview 为带 `ready` 状态的持续 running job，通过 cancel 正常停止并记录原因。
对终态重复取消是无副作用操作，返回既有终态；这是应用 job 契约，不冒充实验 MCP Tasks。

### 调度与停止

- 所有重扫描、编译、测试和同步校验在 worker/受控子进程运行。查询和取消不能被
  `execFileSync`、巨大目录扫描或输出背压阻塞。
- 默认每 workspace 只执行一个重任务，队列最多 8 个；预览单独限制为一个实例。
  锁按真实 workspace/engine-root 定位，必须跨 MCP 进程和 SDK 版本生效。
  源码维护模式对同一引擎根保守串行化准备/声明/构建/测试。
- SDK 只读，游戏构建对选定输入做快照并记录摘要；快照期间变化则拒绝发布不一致结果。
  同一 SDK、已验证 release 与 requestKey 在 7 天窗口内返回同一 job；不同规范化参数
  或 timeout 复用该 key 则拒绝。新发行请求不能复用另一 release 或未知历史 producer 的
  job，即使 SDK 与文本 key 相同；同一已验证 release 可重定位，保留同 workspace/state
  下的去重。源码模式 `releaseId: null`，输入身份仍绑定 SDK 根路径。
  改代码后需要新 key，旧 job 的快照不能被当成最新输入。
- 普通调用预算 5 秒，启动 receipt 目标 1 秒内返回。默认游戏构建 10 分钟、源码测试
  30 分钟，硬上限 60 分钟，截止时间从提交起计入排队；预览默认 TTL 30 分钟，
  显式请求最多 2 小时，其他扫描/创建/检查操作也必须有冻结的超时和输入规模上限。
- 短请求取消按协议处理；receipt 已返回后使用 job_cancel。客户端关闭 stdin 或服务正常
  退出时，停止本会话任务和预览，不留下后台 daemon。
- POSIX 使用独立进程组及 IPC 断连监督；Windows 使用 Job Object 或经实测的等价
  进程树管理。不能只杀父 PID；宽限 5 秒后强制终止，10 秒内确认本工具的进程树退出。
- 需要宿主辅助程序时放在工具发行链，不恢复引擎 native 目录。进程树清理若在某宿主
  尚未可靠实现，该宿主不得标记正式支持。

### 崩溃与保留

任务元数据、锁和日志使用用户私有状态目录，按 SDK/workspace 隔离并限制访问权限。
采用原子更新及实例标识；重启后未完成 job 标为 interrupted，不自动重放构建或继续写出。
必须验证存活进程和实例所有权才回收锁，不能仅凭旧 PID 杀可能被复用的进程。
异常终止测试必须覆盖服务器被强杀、worker 崩溃、磁盘满、管道断连及启动中取消。

日志保留默认 7 天、每 job 8 MiB、每 workspace 总量 256 MiB，包含脱敏和截断标记。
达到上限仍持续消费子进程输出，不能因停止读管道造成死锁。过期 cursor 明确返回失效或
截断信息；终态元数据记录退出结果和丢弃字节数，不能用截断隐去失败。
自动清理仅覆盖工具拥有的过期日志、元数据和失败 staging，不清理用户游戏或已交付产物。

当前元数据 v5 将 SDK-scoped 产物所有权独立于七天 jobs/logs/keys 保存。v2/v3 成功
receipt 在任务过期前迁移到登记表，v4 导入保留已有独立登记；不补造缺失 provenance，
不从未登记目录推断所有权。已交付产物不随 job 过期，仍计入跨 SDK 配额，HTML5 产物
仍可按 artifact ID 预览。另一 release 打开同一 SDK 状态时保持原 producer，不重新
归属或改写历史来源；这不允许新发行请求复用旧 job。旧二进制不保证能读 v5，回滚需
离线的升级前状态备份，不能通过覆盖未知或损坏的状态“修复”。

### 发布产物

构建写入独立 staging，成功退出后校验清单、资源引用、非空文件、模块链接和摘要，
再以新 artifact ID 提升为可预览/可导出的只读结果。失败/取消不替换之前的成功产物。
同一路径已有非本工具内容时拒绝；任何覆盖或清理都不能靠模型传 `confirm: true` 绕过权限。
BILIBILI 预检继续遵循原校验器：每包 4 MiB、总计 30 MiB 仅是源码大小 warning，
不是厂商最终编译包体验收；非空入口检查也不等于游戏能运行。

## 8. 安全设计

### 授权与路径

- 默认 `read-only`；用户在本地启动流程显式授予 develop、preview、execute-tests 或
  maintainer/prepare 能力。MCP 参数不能增加可信根、切换权限或修改客户端配置。
- workspace/SDK/engine-root 在启动时验证和 `realpath` 固定。客户端 roots 通知仅作提示，
  不能作为用户授权。多个不相关项目的读取权限不能通过 job ID 或资源 URI 互相扩大。
- 检查真实路径边界及祖先目录，对拟创建路径先验证最近已存在父目录。拒绝下级 symlink、
  junction/reparse 逃逸、特殊设备文件、Windows UNC/跨盘/ADS、路径大小写边界绕过。
- 读取、快照和最终写入都复查边界；限制深度、文件数量、字节数与单个 JSON 大小。
  测试链接置换竞争，不能把一次 `startsWith` 或一次 `realpath` 描述为完整隔离。
- tsconfig 的 extends/references/paths、代码依赖解析及资源引用也必须限制到授权项目和
  SDK 白名单。只读诊断只解析数据，不执行 JS 配置、插件、hooks 或项目 scripts。

### 执行与信息

- 子进程使用固定可执行文件和独立参数数组，`shell: false`；输入不能决定命令名、
  shell 片段、任意 flag、任意 cwd 或任意环境变量。运行时不能意外调用 PATH 上的同名程序。
- 清理 MCP 与编译/测试子进程的继承环境，特别是 `NODE_OPTIONS`、`NODE_PATH`、
  包管理器注入项及 AI/provider 密钥。仅传任务需要的系统/临时目录/语言等白名单；
  不改 AI 客户端自身的认证环境，不打印全量环境或客户端配置。
- 日志和返回值脱敏 token、认证头、URL 凭据及用户明确标记的秘密；默认不索引 `.env`、
  密钥、`.git` 或全机文件。不能宣称正则脱敏可保护任意恶意代码输出的所有秘密。
- 文档、项目文本和进程日志均是数据，不得解释成新权限或执行指令。包校验只读解析，
  不通过 require/import 执行待验证的 `game.js`。
- 执行仓库脚本、游戏测试或第三方插件不等于沙箱。代码执行需信任授权；如需处理不可信
  项目，应使用独立 OS 隔离环境，不能用 `shell: false` 冒充文件/网络隔离。
- 套件默认不发起下载、遥测、上传或自动更新。不通过关闭 TLS、跳过摘要、伪造声明或
  静默修复生成目录绕过诊断。已授权代码自身联网的风险与套件的无自动联网策略分别说明。

### 本机预览

预览只绑定 `127.0.0.1` 的临时端口，返回带会话令牌的 URL；只服务已验证 artifact 的
白名单资源，不暴露工作区根、源配置、状态目录和 `.env`。校验 Host/Origin、URL 解码及
路径穿越，禁止任意代理、跨域通配和远程 eval 接口。启动监听需要 preview 权限，
不会自动打开或控制浏览器。开发者手动交互及后续浏览器测试不等于 MCP 执行引擎脚本。

## 9. Skills 交付

skills 是发布版本的一部分，不是把目前 `.opencode/skills` 原样复制就算完成。

| 内容 | 发布要求 |
| --- | --- |
| `cocos4-devkit` | 定位发布包、能力查询、项目创建/检查/预览、job 查询取消、权限与验收分层 |
| `cocos4-minigame-dev` | 公共 API、生命周期、UI/input、资源所有权、2D/3D、音频、池化、性能及平台服务边界 |
| references/examples | 所有相对链接随包有效，代码匹配随包声明和 profile；资源前置条件可复现 |
| 维护者 skill | `cocos4-engine-dev` 保留在源码工作流，普通发布包不默认加载或引导用户克隆引擎 |

游戏 skill 首先识别 SDK manifest 或已有 Creator 项目，不能固定向上三级寻找源码。
portable 流程不要求 Creator 3.8.8，也不出现必须 `npm ci`、`setup:external`、
`build:declaration` 的普通用户步骤；现有 Creator 项目的实际工作流仍需保留。
默认使用带版本的离线 API/示例和 MCP 能力清单，不凭通用 Cocos 教程推断平台支持。

现有 `check-examples.cjs` 依赖源码中的 `bin/.declarations`、TypeScript 和
`scripts/test-declarations/tsconfig.json`，需要增加真实的发行包检查入口，而不是用
空 `cc` 声明绕过。包内示例必须只依赖随包资源；需要预导入 bundle 的示例应补齐真实
输入或明确不属于开箱示例，不能把它当可直接运行的模板。

技能验收应让 AI 实际完成“创建可玩游戏、修改玩法、引入类型错误并定位修复、切换
已提供 profile、检查/预览/导出”的闭环，记录客户端/模型版本和工具调用轨迹。
同时使用确定性的协议测试重放关键流程，不能只依赖一次模型演示。
提示词指导可执行步骤，但不能自动提升权限、伪造验证或把提交/上传作为默认动作。

## 10. 实施阶段

| 阶段 | 工作与交付 | 可核查出口 |
| --- | --- | --- |
| P0 可行性 | 锁定独立 SDK/TS 组合；查清模块加载、builtin/shader、游戏代码编译和宿主进程树管理 | 源码不可访问时 2D/3D 真实首帧与交互；类型组合通过；列出所有依赖及再分发许可，未闭合项不能跳过 |
| P1 预编译套件 | 新建独立工具包及发布生成器；干净构建 profiles、类型、资源、catalog、manifest 和 runtime | 包内依赖闭包检查；无系统 Node/npm/Git 的离线机器启动 doctor；重定位和只读 SDK 可用 |
| P2 游戏 CLI | 标准代码模板、检查、游戏编译、资源组装、产物校验、预览，共用应用层 | 用户仅修改游戏 TS/资源即可重新构建；负例拒绝未知资源/缺失 feature；旧成功产物不受失败影响 |
| P3 MCP | stdio、schema、resources、jobs、锁、权限、日志和取消 | 官方 SDK client 黑盒测试；stdout 纯协议；只读拒绝写操作；并发/恶意输入/超时/断连/强杀通过 |
| P4 AI 与 skills | 改造随包 skills/示例检查；OpenCode 临时连接启动器和其他客户端说明 | 新客户端会话发现工具与 skills；无需引擎目录或 Creator 完成 AI 开发闭环；不修改全局配置 |
| P5 小游戏组装 | BILIBILI 完整代码游戏组装，复用模板/adapter/只读校验；保持 WECHAT/OPPO 引擎回归 | 浏览器成功游戏可生成完整 B 站目录；检查入口/模块/资源/配置；厂商编译和设备结果独立记录 |
| P6 发行验收 | 多宿主干净机测试、离线测试、签名/校验和、SBOM/许可证、升级回滚说明、文档 | 仅发布通过矩阵的宿主包；可重复制备；公开实际体积与限制；经用户另行授权后才发布 release |
| 后续维护扩展 | 可选源码构建/回归/prepare tools，其他平台 exporter/profile 与高级资源链路 | 不改变 portable 前置条件；每个新增能力有独立安全及平台验收 |

建议源码放在 `tools/devkit/`，按实际职责保持少量模块：CLI/MCP 入口、共用应用操作、
manifest/catalog、工作区策略、job/进程、游戏构建/预览。单独放测试 fixtures 和发行脚本。
既有 BILIBILI 校验与模板继续归原文件维护，不复制成第二套实现；引擎构建入口仅在确需
复用时提取最小函数。生成包进入忽略的产物目录，不提交 runtime、生成 PAL 或 adapter。

实施完成阶段后补充具体版本、命令、制品摘要和证据，不以“已写代码”代替出口验收。
不能先发布一个仍要求用户克隆源码的版本，再把无源码要求无限期留到后续。

## 11. 验收矩阵

### 11.1 自动化与安全

| 层次 | 必测内容 |
| --- | --- |
| Schema/协议 | initialize、版本协商、tools/list/call、resources/list/read；正常/未知/非法输入；outputSchema 与 text 一致；无服务横幅污染 stdout |
| 类型与依赖 | 引擎 TS 4.9.5 基线、独立工具 TS 检查、随包真实声明消费者、装饰器运行行为；不能关闭库检查 |
| 文件与授权 | `..`、绝对/编码/Windows 特殊路径、symlink/junction、输出冲突、tsconfig 越界、日志秘密、巨量/特殊文件、目录链接竞争 |
| 任务 | 重复 requestKey、排队/多进程锁、取消与完成竞争、超时、服务器强杀、worker 崩溃、磁盘满、输出背压、日志分页/过期、断连回收 |
| 产物 | 无旧文件污染；资源引用与摘要有效；失败不覆盖成功；不同 SDK/profile 不混用；验证 release/profile 来源及旧记录不补造来源、过期产物独立所有权、同 release 重定位与跨 release key 隔离；缺失 WASM/声明/adapter 必须报错 |
| 无源码/离线 | 全新 VM，仅复制发行包和用户游戏，无源码挂载/旧缓存/系统 Node/npm/Git/Creator；阻断外网后检查、构建、预览均通过 |
| 宿主 | 含空格/中文/较长路径、移动解压目录、只读 SDK、无管理员权限、不同 cwd、端口占用、后台进程清理、签名/系统警告 |
| 许可证/发行 | 每个打包文件可追溯；Node/加载器/编译器/WASM/字体等许可保留；无法确认再分发权的组件不得混入通用包 |

纯 mock 测试用于失败路径，不能替代真实 bundle、真实声明和实际执行程序的集成测试。
终态作业退出后不得残留本工具启动的进程或监听端口；控制面在重任务期间仍需响应。

### 11.2 游戏与客户端

- 在每个对外支持的宿主使用发行包，而不是 `node tools/.../src`，完成 2D/3D 示例。
  记录浏览器、GPU、画面证据、交互结果和 console 错误，空白画布或加载错误必须失败。
- 2D 示例覆盖触摸/鼠标、UI 布局、图片/JSON/音效、得分/失败/重开；3D 示例覆盖相机、
  网格/材质、输入和 UI。至少连续重开 10 次验证没有重复事件或明显资源持续增长。
- 验证缺失资源、错误脚本、未提供的物理 API、浏览器音频限制及任务取消均给出可执行
  诊断。性能预算在 P0 记录具体硬件与基准后冻结，不能引用无硬件条件的 FPS 承诺。
- OpenCode 记录具体版本：发现 tools/skills、查询文档、创建游戏、检查、读取失败日志、
  修改代码再构建、预览及取消。保存临时接入下的 `opencode mcp list` 和协议证据。
- 禁用客户端 resources 展示时仍能通过 docs tools 完成流程；不支持实验 Tasks 的客户端
  仍可轮询所有长任务。模型演示不代替稳定的 client 协议回归。
- 网络隔离测试针对套件自身；AI 在线模型需另行放行或使用已有本地模型，不能将 API
  不可达误判成引擎安装失败，也不能借此要求联网安装工具。

### 11.3 引擎回归

未来涉及引擎构建、适配或发布脚本修改后，在源码仓库执行适用的真实命令：

```sh
npm run prepare:engine
npm run test:platforms
npm run build:declaration
npm run test:dts
npm test -- --runInBand
npm run build:minigame -- BILIBILI
npm run build:minigame -- BILIBILI base,3d,animation,skeletal-animation,gfx-webgl,gfx-webgl2
npm run build:minigame -- WECHAT
npm run build:minigame -- OPPO
npm run build:dev
git diff --check
```

不得并发运行写相同输出的构建。上述显式 3D smoke 列表不包含 UI/audio/物理，不等同于
拟定的 `3d-basic` profile；发行生成器还需覆盖自己的实际 feature 全集和 release 组合。
包预检使用现有入口 `npm run validate:bilibili -- /absolute/path/to/complete-game-output`。
本计划不把历史 BILIBILI 回归数量当成 MCP 或新发行包的测试结果。

### 11.4 支持声明

| 可以宣称的状态 | 必须拥有的证据 |
| --- | --- |
| MCP 可连接 | 指定客户端的实际握手、工具发现和调用 |
| 套件无需源码 | 干净机仅使用发行包完成类型检查和构建，且无自动安装/下载 |
| 可无 Creator 开发 | 同一环境中 2D/3D 可玩、修改代码后重建预览成功 |
| 可组装 B 站游戏 | 完整游戏入口、引擎/adapter/脚本/资源闭包通过组装和本地预检 |
| 厂商打包通过 | 对应厂商工具版本的真实编译结果及实际包体统计 |
| 真机通过 | 指定设备/OS/容器 SDK 的输入、音频、前后台、资源、图形/WASM 与性能记录 |
| 可以发布/已上传 | 用户授权下的厂商验收/上传结果，不能从前几层推导 |

首个 portable beta 至少完成 P0-P6 的本地出口和支持宿主验证。厂商工具或真机缺失时，
可以明确发布为本地开发 beta，但小游戏输出必须标记尚未完成的验收层次；不得宣称
“完整厂商发布支持”。现有引擎的 Creator 集成仍保留，但不是 portable 游戏闭环的验收前提。

## 12. 当前进度

- [x] 确认独立引擎 MCP 和无需源码的便携发行目标。
- [x] 梳理现有入口、副作用、skills 依赖和无 Creator 链路缺口。
- [x] 形成工具契约、安全边界、分阶段实施及验收计划。
- [x] 锁定独立 SDK/TS/Zod 与加载器依赖；严格检查和 8 项探针测试在 Linux Node 18.20.8/24.21.0 通过。
- [x] 实测 stdio 协议与真实 SystemJS 加载器，记录高层 SDK 契约差异、类型泄漏及全局对象桥接要求。
- [x] 找到匹配引擎版本的公开 Effect 编译器候选，记录其宿主依赖和未解决的许可证声明差异。
- [x] 提取无引擎启动副作用的真实 offline-mappings；保持旧枚举导出、数值及对象身份。
- [x] 固定源码摘要、独立安装宿主 GL 编译依赖；2D 的 5 个 Effect、10 个材质编译及重复摘要验证通过。
- [x] 实现只读 stdio MCP/CLI：十个真实工具、固定 resources、严格信封及错误路由；未提供游戏写入/构建/预览占位工具。
- [x] 实现受限 Linux 文件读取、私有快照、canonical BILIBILI worker 校验、任务持久化/分页/锁/取消及跨 SDK 隔离。
- [x] 官方 SDK 黑盒验证握手、元数据、非法参数、分页、真实任务、stdin EOF 及 stdout 背压清理。
- [x] 修复 3D deferred-lighting 的 EFX2404：锁定 glslang 条件预处理补丁，保留严格 AST/parser 与真实 GL 检查。
- [x] 生成实际 2D/3D HTML5 debug runtime、完整声明、模板和独立 compiler closure，验证离线 SDK 重定位。
- [x] 接通项目创建、类型检查、游戏构建、预览启停；固定 worker 准备，父进程非覆盖发布，默认只读。
- [x] 官方 MCP/CLI 测试修改后游戏与产物，真实 Chromium 验证两种 profile 绘制、输入、音效和重开。
- [x] 声明驱动 API/成员索引与实际模板源码示例查询，绑定声明、源位置和各 target/profile 的运行时导出摘要。
- [x] 真实 BILIBILI 2D/3D 引擎、loader、adapter 和 Application 纳入混合 SDK；本地宿主接口模拟与浏览器/厂商证据分开。
- [x] game_build 接入 BILIBILI 源码包组装、项目 game.json、静态模块闭包和 canonical preflight；BILIBILI 产物禁止浏览器预览。
- [x] 独立构建八种 debug/release profiles；修复 BILIBILI 同名 exporter 误判，两版本的四种公开 release 游戏流程均通过，HTML5 新产物有真实浏览器证据。
- [x] 增加独立 execute-tests 授权、固定 Node 逻辑 runner、Linux 进程树监督及 8 MiB/job、256 MiB/workspace 日志；两版本逻辑/生命周期矩阵各 35 项通过。
- [x] 修复已交付产物被元数据过期清理的问题；早期任务回归两版本各 31 项通过，原失败证据不覆盖。
- [x] 元数据 v5 独立保留 SDK 产物所有权和原 producer，新增已验证 release/profile 来源；v2/v3/v4 导入不补造 provenance。过期 HTML5 产物仍可预览并计入跨 SDK 配额，未登记目录阻止发布；新发行 key 不复用旧发行或未知 producer，同一已验证 release 可重定位。父任务直接测试两版本各 139 项通过，历史 v4 的 136 项报告保留，不冒充当前全量结果。
- [x] 临时 OpenCode 1.18.21 接入及受限文件工具通过两版本各 37 项 focused 测试、93 项真实客户端文件操作检查；未包含模型请求。
- [x] 生成内置 Node 24.21.0 的 Linux v5-a 候选包；SDK-only doctor 无需 workspace/HOME/state，显式 workspace 保留 jobs；AI 子 MCP 使用 static-no-libc helper，不依赖运行时 `/usr/bin/env`，独立 provider 认证环境不变。实际 startup/archive 选定测试 34 项通过，无失败/跳过/取消，输入未变。
- [x] v5-a 在无源码/宿主命令/用户缓存、只读挂载和断网 namespace 中完成八个实际构建及四个 HTML5 浏览器报告，release/profile 身份断言通过；覆盖 2D/3D、debug/release、修改后的玩法、输入、资源/音频和重开，浏览器及驱动单独显式挂载。这不是全新 VM、其他 OS、模型或厂商/真机验收。
- [x] 修正 SPDX 归档摘要语义、补齐宿主声明及 schema 组件记录；修复 tar PAX 原路径泄漏，历史 e/f 两次实际完整归档具有相同摘要，不是 v5 重复制备证据。许可缺口仍明确阻止正式发行。
- [x] 2026-09-25 的 variant-aware skill 检查及后续候选包组装已有保留证据，详见 [9 月 24-25 日历史记录](../../tools/devkit/ACCEPTANCE.md#september-24-25-checkpoint)；不代表完整候选包或模型验收。
- [x] 修复验证输入传递、取消/结果发布边界和作业轮询时限；定向检查发现并修复 readiness JSON 发布竞态，只重跑失败文件。精确命令、通过与失败记录见 [9 月 26 日定向验证](../../tools/devkit/ACCEPTANCE.md#september-26-focused-verification)，当时没有重建 SDK 或候选包。
- [x] 完成新候选包的 [Packaged 2048 Check](../../tools/devkit/ACCEPTANCE.md#packaged-2048-check) 定向交付；仅此项完成，不代表完整发行、全平台或全部 AI 目标完成。
- [ ] 完整合并矩阵、候选包验收及实际模型闭环仍未完成；最新 Node 18 矩阵已中断，不是正在运行，也没有当前两版本全量通过记录。遵照用户要求不再执行全量矩阵，只做必要的 focused 检查；定向通过不代表完整发行验收。
- [ ] 完成新增 CI 前置条件的干净 checkout 与 hosted rehearsal；历史 `verification-inputs` 两版本各六项通过只证明编排契约，尚未运行完整排练。
- [ ] P0 独立启动、资源链路与工具链可行性验证。
- [ ] P1-P2 预编译发行骨架和游戏 CLI。
- [ ] P3 MCP 协议、任务和安全实现。
- [ ] P4 skills 与实际 AI 客户端闭环。
- [ ] P5 无 Creator 小游戏组装与分层验收。
- [ ] P6 干净机、多宿主、许可证及可追溯发行验收。

当前实现包括真实 mappings、严格 2D/3D builtin 编译、SDK 内游戏编译器、预编译 runtime，
以及受权限约束的开发 MCP/CLI。真实浏览器验证使用软件 WebGL，不代表硬件或厂商真机验收。
它们仍不是完整发行套件：虽然 Linux 候选包已包含 Node、编译工具和宿主辅助程序，
但完整合并矩阵、实际模型闭环、全新 VM、多宿主和许可/来源认证仍有未完成项。
厂商编译、上传和真机仍未验证，不以本地源码包预检冒充发布成功。
开发操作的 RequestKey 已必填，检查/构建支持有界 timeoutMs；需以当前 MCP schema 为准。
新候选包身份与 2048 定向结果统一见 [当前验收记录](../../tools/devkit/ACCEPTANCE.md#packaged-2048-check)；
该次组装取代“候选包未重建”的当前状态，但未重建引擎/SDK，也不承接旧矩阵通过结果。
2026-09-24/25 的 SDK/候选包、skill 检查及中断结果保留为
[历史检查点](../../tools/devkit/ACCEPTANCE.md#september-24-25-checkpoint)；以下历史证据不转移到新候选包。
此前保留的 v5-a 候选包为 `tools/devkit/build/portable-candidate-20260922-v5-a`，6,037 个 payload
文件、300,964,724 字节，归档 76,394,705 字节；完整 release/SDK/archive SHA-256 见
[验收清单](../../tools/devkit/ACCEPTANCE.md)。实际 startup/archive 报告为
`build/matrix-node24-93jqOD/result.json`（34 passed、0 fail/skip/cancel、unchanged），
实际 namespace/browser 报告为 `build/portable-host-bAPi9z/result.json` 及其 workflow
报告（八个构建、四个浏览器报告、来源断言通过）；路径相对 `tools/devkit/`。
父任务 `node --test` 的 artifact-lifecycle/jobs/job-logs/preview 两版本各 139 passed、
0 fail/skip，Node 24 game 测试 49 passed，含实际 profile SHA-256 与 release mismatch
拒绝。这些是历史终端命令证据，没有捏造新的保留报告；本次定向结果单独记录，不重复引用旧计数作为新验证。
旧 `build/matrix-node24-ktQbxU/result.json` 的 `interrupted: true` 与全 null totals 保留，
前序 `build/matrix-node24-E9bbpP/result.json` 的 510 tests / 492 passed / 18 failed 也保留。
模型尝试 `build/ai-model-20260921-7Qm4waaE/REPORT.md`、`audit.redacted.json` 使用真实
OpenCode 1.18.21 和 `opencode/big-pickle`，收到 HTTP 403 `FreeTierError`，0 模型文本、
0 工具调用；连接门禁失败后未提交玩法 prompt。它不是成功闭环，也不证明所有模型不可用。
历史 agent 临时证据已归档到 `build/retained-*.tar.gz`，五份精确文件名和 SHA-256 见验收
清单；归档只是保留，不是重跑。所有未完成的 P0-P6、干净源码来源、认证、许可、全新 VM、
多宿主和真实模型要求继续保留，不能从局部通过推导完整目标完成。
维护源码直接修改当前项目；需要保留的 SDK 和验收证据位于已忽略的 `tools/devkit/build/`，不以系统临时目录作为唯一存储。
默认 worker 不运行项目代码；显式授权的逻辑测试不是沙箱。父进程通过随包 C helper、
descriptor chains 和 renameat2 非覆盖发布，运行时不依赖 Python；Python 仍用于维护者 SDK 准备。
发布与任务元数据并非单一事务，崩溃可能留下已创建项目或未登记产物；保留它们供核对，不自动重放或删除。
Linux 监督不能代替 Windows Job Object/macOS 的实际实现和验收，namespace 也不是全新 VM。
根 MIT 许可与部分源码限制性声明、编译器/加载器的许可元数据差异需要在发行前澄清；
不能通过删除原声明绕过。详细证据和下一步见 [P0 记录](../../tools/devkit/README.md)。

## 13. 参考

- [维护边界](../../AGENTS.md)
- [当前引擎说明](../../README.zh-CN.md)
- [BILIBILI 已有计划和验证边界](bilibili-minigame-export.md)
- [BILIBILI 接入说明](../bilibili_minigame/README.md)
- [现有 skills](../../.opencode/skills/README.md)
- [引擎验证规范](../../.opencode/skills/cocos4-engine-dev/references/verification.md)
- [小游戏构建脚本](../../scripts/build-minigame.cjs)
- [BILIBILI 只读校验](../../scripts/validate-bilibili.cjs)
- [游戏初始化](../../cocos/game/game.ts)
- [Builtin 资源加载](../../cocos/asset/asset-manager/builtin-res-mgr.ts)
- [MCP tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP resources 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [MCP transports 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Tasks，当前 experimental](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [OpenCode 配置权威 Schema](https://opencode.ai/config.json)

协议及 SDK 调研日期为 2026-09-16；实施和升级时重新核对，不把上游最新版本自动等同于
本发行包已经支持的版本。
