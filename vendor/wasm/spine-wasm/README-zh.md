# Spine WASM 编译指南

此目录保留 WebAssembly/ASM.js 共享适配层，相邻的 `../spine` 目录保留
Spine 3.8、4.2 运行时源码及其许可证声明。这些源码可通过 EMSDK 独立构建，
不依赖原生引擎或平台模板。

## 环境要求

- EMSDK 3.1.41，按官方文档完成安装和激活。
- CMake 和 Ninja，均需加入 `PATH`。

配置前先激活 EMSDK 环境。Linux/macOS 执行
`source /path/to/emsdk/emsdk_env.sh`；Windows 执行 SDK 的 `emsdk_env.bat`。

## 构建

从引擎仓库根目录执行。构建目录可以位于源码树之外，以下示例使用 `/tmp`
（Windows 请替换为适合的路径）。

```bash
emcmake cmake -S vendor/wasm/spine-wasm -B /tmp/spine-wasm-3.8 -G Ninja \
  -DSPINE_VERSION=3.8 -DBUILD_WASM=1 -DCMAKE_BUILD_TYPE=MinSizeRel
cmake --build /tmp/spine-wasm-3.8
```

三个选项均为 CMake 缓存变量，无需修改源码：

- `SPINE_VERSION`：`3.8`（默认）或 `4.2`。
- `BUILD_WASM`：`1`（默认）生成 WebAssembly，`0` 生成 ASM.js。
- `CMAKE_BUILD_TYPE`：`MinSizeRel`（默认）、`Release`、`RelWithDebInfo` 或 `Debug`。

不同版本和输出格式使用独立构建目录，例如：

```bash
emcmake cmake -S vendor/wasm/spine-wasm -B /tmp/spine-asmjs-4.2 -G Ninja \
  -DSPINE_VERSION=4.2 -DBUILD_WASM=0 -DCMAKE_BUILD_TYPE=MinSizeRel
cmake --build /tmp/spine-asmjs-4.2
```

## 构建产物

发布产物时，请在已激活 EMSDK 的 Bash 环境中，从仓库根目录运行 CI helper：

```bash
bash .github/workflows/build-spine.sh /tmp/spine-dist
```

该脚本构建两个版本及两种格式，临时应用仓库中的 embind `bind.cpp` 补丁，
并在退出时恢复 SDK 文件。上述直接运行 CMake 的命令适用于未打补丁的本地构建，
不是发布流程。脚本运行期间，不要使用同一 SDK 并行执行其他构建。

- WebAssembly：保留 `spine.wasm`，将 `spine.js` 重命名为 `spine.wasm.js`。
- ASM.js：若生成 `spine.js.mem` 则保留，将 `spine.js` 重命名为 `spine.asm.js`。

将产物发布到仓库根目录 `external-config.json` 所指定的外部依赖发行包中，
路径为 `emscripten/spine/<version>/`。这些源码不附带外部构建产物或 EMSDK，
本地构建不会下载依赖，也不会创建兼容目录。
