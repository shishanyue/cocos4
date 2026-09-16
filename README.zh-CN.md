# Cocos 4 小游戏引擎

本分支只面向小游戏和厂商快游戏，保留 TypeScript 2D/3D 引擎、Creator 集成、
浏览器预览、WebGL/WebGL2 和 TypeScript WebGPU 后端。
原生应用发布、JSB、原生平台后端和原生模拟器已从源码中移除。

后续开发边界见 [AGENTS.md](AGENTS.md)。不要依据旧版 Cocos 的原生架构补回已删除的实现。
引擎本体开发和小游戏项目开发分别提供独立的 [开发 skills](.opencode/skills/README.md)，
包含源码索引、验证流程、组件示例及跨项目使用说明。

## 平台范围

已有适配实现：微信、抖音/字节、支付宝、淘宝、小米、OPPO、vivo、华为、荣耀、咪咕。
微信小程序和淘宝创意互动是独立容器集成。
SUD、SUD V2、Cocos Runtime 保留运行时接入点，其外部发布工具仍需验证。
保留 Facebook Instant Games 的 HTML5 模板；百度遗留模板不代表当前支持构建。

`cc.config.json` 是引擎构建目标白名单。`HTML5`、`NODEJS` 用于开发工具和预览。
“存在适配实现”不代表已经通过当前厂商 SDK、打包器和真机的发布验收。
华为快游戏不等同于 HarmonyOS/OpenHarmony 原生应用。

## 开发环境

需要 Node.js 18 或更新版本、npm 和 Git。
普通小游戏开发不需要 NDK、Xcode、SWIG 或原生平台 SDK。

```sh
npm ci
npm run setup:external
npm run build:declaration
```

安装阶段准备过滤后的 PAL/adapter、对锁定版 `@cocos/ccbuild` 及其声明打包器 `@cocos/tfig` 应用经过校验的补丁，
并生成常量和错误信息。不再安装原生打包工具。
`setup:external` 独立获取锁定版本的 Web/WASM 制品，放到 `external/emscripten`，
不会覆盖已跟踪的 `external/compression` 和 `external/deserialize`。
也可以使用已有 external 仓库副本：

```sh
npm run setup:external -- --source /path/to/cocos-engine-external
```

如果禁用了依赖安装脚本，请显式执行 `npm run prepare:engine`。
网络故障不应通过关闭 TLS 或完整性检查解决；可以使用 npm 标准 `--registry` 参数选择镜像。

## 构建与测试

`build:declaration` 同时检查引擎源码和生成的运行时/编辑器 API 声明，
输出包含 WebGPU 环境类型。可用 `test:dts` 单独复查已有声明产物，无需重新生成。

```sh
npm run test:platforms
npm test -- --runInBand
npm run build:minigame -- WECHAT
npm run build:minigame -- OPPO
npm run build:minigame -- WECHAT base,3d,animation,skeletal-animation,gfx-webgl,gfx-webgl2
npm run build:dev
npm run build:cli-min
```

`build:minigame` 生成的是引擎包，不是完整游戏项目或厂商上传包。
资源转换、平台注册和最终项目打包仍由对应 Creator/builder 集成负责。

Creator 需要使用本引擎打过补丁的构建依赖。
浏览器预览的 `/engine_external/` 接口必须指向本分支的 `external/`；
编辑器 PAL 从 `query-engine-info.typescript.path` 获取引擎目录，不再使用原生引擎路径。
完整编辑器与预览服务器源码不在本仓库，必须在实际使用的编辑器版本中验证这些约定。

## 保留的共享实现

- `vendor/wasm/` 保留 Spine WASM/ASM.js 适配源码及 3.8/4.2 runtime，使用独立 Emscripten/CMake/Ninja 构建。
- `scripts/gfx-define-generator/` 保留共享 GFX 定义生成器，不依赖原生应用工程。
- `nativeAsset`、`nativeUrl` 等表示原始资源数据，不是原生发布支持。
- Android/iOS 设备兼容、安全区和输入逻辑仍用于手机上的小游戏，不能按关键词删除。
- Spine 和其他第三方库继续遵循各自许可证，不能用引擎 MIT 许可替代。

平台测试不替代编辑器、真实 GPU 和厂商真机验收。
发布前应覆盖小游戏/runtime 两条路径、2D/3D、分包、WASM、输入和音频生命周期。
共享 CI 的外部前提见 [.github/WEB_CI.md](.github/WEB_CI.md)。
