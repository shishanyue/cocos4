# HTML5 → Android APK

这个源码工具把已经生成的 HTML5 静态客户端封装进 Android WebView。网页、
引擎、贴图、Spine、字体和音频都在 APK 中；服务器只需保留游戏后端。
引擎目标仍是 `HTML5`，`NATIVE=false`、`JSB=false`，不恢复 JSB、NDK 或
原生渲染后端，也不修改完整性保护的 `D:\cocos4-work\devkit-win32-run9`。

入口为 `export-apk.mjs`，无需 npm 安装。Node 18+ 可运行；可使用已有 devkit
附带的 Node。当前工具在源码仓库提供，run9 启动器没有 APK 子命令。

统一源码 CLI 也支持 `apk` 子命令（先在 `tools/devkit` 运行 TypeScript 构建）：

```powershell
npm run build --prefix D:\Github\cocos4\tools\devkit
node D:\Github\cocos4\tools\devkit\build\src\cli.js apk tools
node D:\Github\cocos4\tools\devkit\build\src\cli.js apk export `
  --input D:\cocos4-work\stronghold-web --output D:\cocos4-work\stronghold-android `
  --config D:\cocos4-work\stronghold-apk.json --mode develop
```

新便携包自动携带 `app/android/` 工具与此文档，并通过 `cocos4.exe apk` /
`cocos4 apk` 使用相同入口；完整性清单覆盖工具代码。`apk tools` 输出能力清单，
`apk --help` 给出导出、检查和两种实建入口。`export`、`build`、`build-direct`
需要显式 `--mode develop`；`verify`、`doctor` 只读。APK 路线不使用 Cocos 的
workspace/state 参数，也不会添加 Android 引擎目标。当前 APK 能力通过 CLI
调用，MCP 的游戏构建/导出目录仍只记录原有 HTML5/小游戏目标。run9 不包含
这一新入口；不要将新文件复制进去破坏旧包清单。

## 导出静态客户端与 Android 项目

先生成完整的静态站点根目录，而不是传源码仓库。所有脚本、图片、样式和音频
应已本地化；输出保留 `/assets`、`/vendor`、`/sim` 等网站根路径。
动态计算的资源 URL 还需要浏览器/真机验证，静态检查无法证明它们全部存在。

配置文件示例 `D:\cocos4-work\stronghold-apk.json`：

```json
{
  "appId": "org.stronghold.protocol",
  "appName": "卫戍协议",
  "versionCode": 1,
  "versionName": "1.0.0",
  "orientation": "sensorLandscape",
  "backendUrl": "https://game.example.com",
  "configGlobal": "__SP_CLIENT_CONFIG__"
}
```

```powershell
$env:TEMP = 'D:\cocos4-work\tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
node D:\Github\cocos4\tools\devkit\android\export-apk.mjs `
  --input D:\cocos4-work\stronghold-web `
  --output D:\cocos4-work\stronghold-android `
  --config D:\cocos4-work\stronghold-apk.json
```

`--output` 的父目录必须已存在，输出目录必须不存在；重复导出选新目录。
工具拒绝目录嵌套、链接/junction、不安全路径、`.env`/`.git`/`node_modules`、
缺失的 HTML/CSS/ES module 字面量引用和远程静态资源。不执行输入项目代码。
复制完成后生成 `cocos4-android-export.json`，记录每个文件的 SHA-256；
输入目录和 SDK 保持原状。可复查：

```powershell
node D:\Github\cocos4\tools\devkit\android\export-apk.mjs verify `
  --project D:\cocos4-work\stronghold-android
```

可选字段：`entry` 默认 `index.html`；`orientation` 为 `sensorLandscape`、
`sensorPortrait` 或 `fullSensor`；`minSdk` 默认 26；`targetSdk` 默认 35；
Gradle 工程的 `compileSdk` 固定 35。后端 URL 支持 HTTP(S) origin 与路径前缀，
不允许凭证、查询参数或 fragment。`backendUrl` 为空可封装纯离线游戏。

## 后端、资源与移动端行为

WebView 使用 `https://appassets.androidplatform.net/` 作为本地来源。根目录
资源由 `AssetManager` 返回，支持 WASM MIME、HEAD 和单段 Range（音视频拖动）；
缺失文件明确返回 404，绝不回退到公网。远程页面导航被拒绝。
脚本、DOM storage、WebGL 和硬件加速开启；禁止 `file://` 访问、JS bridge、
网页弹窗和第三方 Cookie。Release 禁止 WebView 调试。默认横屏全屏，保留
系统返回键、旋转、暂停/恢复、安全切边与刘海布局。网页仍须提供正确 viewport
和 `env(safe-area-inset-*)` 样式；音频需用户触摸后开始。

入口 `<head>` 最先加载 `/cocos4-shell-config.js`，设置：

```js
globalThis.__COCOS4_ANDROID__ = {
  schemaVersion: 1,
  platform: 'android-webview',
  assetOrigin: 'https://appassets.androidplatform.net',
  backendUrl: 'https://game.example.com'
};
```

配置 `configGlobal` 时，也会把 `backendUrl` 写入相应游戏全局配置。
游戏自己的配置脚本需保留已注入值，例如：

```js
globalThis.__SP_CLIENT_CONFIG__ = {
  backendUrl: '',
  buildUrl: '/client-build.json',
  ...globalThis.__SP_CLIENT_CONFIG__
};
```

后端应允许来源 `https://appassets.androidplatform.net`。Stronghold 的部署
使用 `SP_BACKEND_ONLY=1` 和 `SP_CLIENT_ORIGINS=https://appassets.androidplatform.net`，
允许跨来源 API/WebSocket 后，服务器不需 UI 素材。客户端配置内不得存密钥。
壳只允许配置的后端 origin 发起网络请求，WebSocket 对应使用 `wss:`/`ws:`。
URL 路径前缀由游戏网络适配器处理。

测试 APK 可配置 `dynamicBackend:true`，让使用者填写自己的后端。该模式只允许
debug 构建；release 导出使用固定 `backendUrl`。壳将单一后端 URL 保存在应用
私有设置中，每次加载按当前地址生成配置脚本、CSP 和网络请求限制。读取接口：

```js
const settings = await fetch('/__cocos4/backend').then(response => response.json());
```

保存接口不读取请求体（Android WebView 的请求拦截 API 不提供它），使用 PUT
和 URL 参数；壳只接受来自本地 `https://appassets.androidplatform.net` 的非主框架
请求。保存成功后重新加载页面，游戏的 `configGlobal` 会收到新地址：

```js
const response = await fetch(`/__cocos4/backend?url=${encodeURIComponent(backendUrl)}`, { method: 'PUT' });
if (!response.ok) throw new Error('Invalid backend URL');
location.reload();
```

读取与保存响应包含 `backendUrl`、`defaultBackendUrl`、`dynamicBackend`、
`allowCleartext` 和 `assetOrigin`。保存空字符串会清除用户设置，恢复 APK 的
打包默认地址；`__COCOS4_ANDROID__` 同样提供这些字段。

地址支持 HTTPS 和路径前缀，禁止凭证、查询参数和 fragment。仅当测试配置显式
写入 `allowCleartext:true` 时，用户才可填写 HTTP 地址。此调试模式的 Android
网络层允许明文，而 WebView 请求检查和 CSP 仍只放行当前保存的单一后端
origin。HTTP/HTTPS 调试地址均由用户明确填写，客户端素材继续从 APK 加载。

固定后端的局域网 HTTP 调试必须显式配置 `allowCleartext:true` 且指定 HTTP 后端。
这时只有该域名可明文访问，WebView 开启混合内容以连接它；页面 CSP 和请求
检查仍限定后端 origin。部署使用 HTTPS/WSS。壳不能修复服务端证书或 CORS。

## 两种托管模式：connect-only 与 lan-host

配置字段 `hostingMode` 决定导出形态，默认 `connect-only`：

- `connect-only`：纯客户端 APK，只能连接外部后端。完全不打包
  `__cocos4_host/` 适配器资源、`HostRuntime.java`、`HostWebSocket.java` 或任何
  宿主组件；传入 `--hosting-dir` 会直接报错。
- `lan-host`：同一客户端加上 Android 本地房主后端。必须同时设置
  `allowCleartext:true`（本地 `ws://` 监听）并提供 `--hosting-dir ABS_DIR`，
  目录根必须有 `index.html`，内容打包到
  `app/src/main/assets/www/__cocos4_host/`。该模式总是导出
  `dynamicBackend:true`（配置写 `false` 也会强制开启）：游戏页在 `start`
  成功后通过 `/__cocos4/backend` 保存 `http://127.0.0.1:<port>` 并
  `location.reload()`；重载不得停止宿主、不得重启监听，重载后的配置脚本与
  请求放行必须继续使用已保存的本地端点。

```json
{ "appId": "org.stronghold.protocol", "appName": "卫戍协议",
  "backendUrl": "http://192.168.1.25:3000", "allowCleartext": true,
  "hostingMode": "lan-host" }
```

```powershell
node D:\Github\cocos4\tools\devkit\android\export-apk.mjs `
  --input D:\cocos4-work\stronghold-web --output D:\cocos4-work\stronghold-android-host `
  --config D:\cocos4-work\stronghold-apk-host.json `
  --hosting-dir D:\cocos4-work\stronghold-host-final
```

适配器目录拒绝 `.git`、`.env*`、符号链接/junction、原生库、NDK 文件和
source-map；客户端素材不得自带顶层 `__cocos4_host/`。导出回执记录
`hosting.mode`、适配器文件清单、字节数和固定的 bridge 契约。

### 隔离后端 WebView 与 Java bridge

`lan-host` 时壳创建第二个隐藏 WebView 加载
`https://appassets.androidplatform.net/__cocos4_host/index.html`，只允许该前缀
资源，与游戏页面互不可见。Java 注入全局对象 `Cocos4Host`，方法（均为 void）：

```text
Cocos4Host.ready(statusJson)      Cocos4Host.setState(statusJson)
Cocos4Host.sendText(connectionId, text)   Cocos4Host.sendBinary(connectionId, base64)
Cocos4Host.ping(connectionId)     Cocos4Host.close(connectionId, code, reason)
Cocos4Host.log(level, message)
```

壳反向调用适配器全局 `globalThis.__COCOS4_HOST_ADAPTER__` 的
`onStart/onStop/onConnect/onMessage/onClose/onError`，参数为单个 JSON 字符串。
`onMessage` 的 `type` 为 `text`、`binary` 或 `pong`；`pong` 携带真实回显的
ping payload（base64）。`Cocos4Host.ping` 发送真实的 RFC 6455 ping 帧，壳绝不
伪造 pong、也不关闭或放宽适配器自己的 heartbeat/hello 超时。

LAN 监听器由纯 Java `ServerSocket` 实现 RFC 6455：掩码、长度规范、分片、
64 KiB 上限、严格 UTF-8、关闭码校验、20 秒 ping/60 秒空闲关闭、`/healthz` 与
`BACKEND_NOT_READY` 503（适配器 ready 前）。`Origin` 原样转发给适配器裁决，
缺失 Origin 允许非浏览器客户端。非 WebSocket 的 HTTP 只返回 `/healthz` 或
404/405，不做静态站点服务。远程玩家仍用各自的 connect-only APK 或浏览器连接
`ws://<android-lan-ip>:<port>/ws`。

本地控制端点只在游戏页来源可见：`GET /__cocos4/host/status`、
`POST /__cocos4/host/start?port=3000&bind=lan&path=%2Fws`、
`POST /__cocos4/host/stop`；响应为 `application/json; charset=utf-8` 且
`no-store`。玩家的 `location.reload()` 只重新加载游戏页：活动存活期间监听器
与适配器 WebView 保持不变，控制端点接受保存本机 `http://127.0.0.1:<port>`
地址（`allowCleartext` 已启用时），`status` 的 `state/startedAt` 在重载前后
不变。`__COCOS4_ANDROID__.localHosting` 暴露 `controlBase`、状态、
`backendUrl`、`wsUrl` 与 `lanUrls`。`start` 先绑定端口再加载适配器 WebView，
15 秒内未 `ready` 进入 `error` 并关闭监听；活动销毁关闭全部连接（1001）并
执行 `onStop`。v1 不提供前台服务或后台常驻保证。

## Gradle 构建

工程固定 AGP 8.7.3、compile SDK 35、build-tools 35.0.0，适用 Gradle 8.9
到 8.14.x、JDK 17/21（Gradle 8.10+ 也支持 JDK 23）。Gradle 9/JDK 25
不能直接用于此固定组合。可在 Android Studio 打开工程，也可使用以下 CLI。
Gradle wrapper/SDK 不自动下载，外部工具链应已安装并由所有者接受其许可。

```powershell
node D:\Github\cocos4\tools\devkit\android\toolchain.mjs doctor `
  --project D:\cocos4-work\stronghold-android `
  --sdk D:\Android\sdk `
  --java-home D:\Java\jdk-21 `
  --gradle-home D:\Gradle\gradle-8.11.1 `
  --work D:\cocos4-work\stronghold-apk-build

node D:\Github\cocos4\tools\devkit\android\toolchain.mjs build `
  --project D:\cocos4-work\stronghold-android `
  --sdk D:\Android\sdk `
  --java-home D:\Java\jdk-21 `
  --gradle-home D:\Gradle\gradle-8.11.1 `
  --work D:\cocos4-work\stronghold-apk-build `
  --variant debug --offline false
```

`doctor` 只检查，不安装。`build` 默认 `--offline true`；首次缺少 Gradle
依赖时用 `--offline false` 显式允许官方仓库依赖解析。子进程 TEMP/TMP/TMPDIR、
Gradle/Android 缓存和 Java 用户目录位于 `--work` 下，Windows 必须在 D 盘。
debug APK 使用测试签名；`--variant release` 生成未签名 APK，由应用维护者
使用自己的 release key 签署。输出 JSON 包含 APK 大小、SHA-256、签名状态和
构建日志路径，不把构建成功称作真机验收。

## 使用现有 SDK 直接构建

`direct-build.mjs` 使用已安装 SDK 的 `aapt2`、Android 平台 JAR、JDK、D8、
zipalign 和 apksigner，免 Gradle 网络依赖。它编译同一组 Java/资源，生成独立
APK，不修改 Android 项目或其文件清单。可用较新 SDK 编译，应用 targetSdk
仍取配置；产物记录实际编译平台和工具版本。

Windows 的 aapt2 会把资源与资产名写成反斜杠（例如 `assets/www\index.html`），而
Android AssetManager 按 `assets/www/index.html` 精确查找，结果是每个本地资源都
404。`direct-build.mjs` 因此在最后一次写 ZIP 之后、zipalign 与签名之前调用
`zip-name-normalizer.mjs`：只把本地头和中央目录里的名字字节 `0x5C` 改成 `0x2F`，
不改 CRC、压缩数据、偏移或对齐，中央目录与本地头不一致、名字冲突或畸形归档都会
明确失败；`--verify-only` 可只读检查已有 APK 是否仍有反斜杠名字。

```powershell
node D:\Github\cocos4\tools\devkit\android\direct-build.mjs `
  --project D:\cocos4-work\stronghold-android `
  --sdk D:\nano\build\android-sdk `
  --java-home C:\Users\Administrator\.gradle\jdks\eclipse_adoptium-21-amd64-windows.2 `
  --work D:\cocos4-work\stronghold-apk-direct `
  --platform 36 --build-tools 36.0.0 --variant debug
```

现有 JDK 可只读使用；所有新工作文件仍在 D 盘。debug key 保存在 `--work`
根目录，重复使用同一工作目录可更新已安装的测试 APK。debug key 为测试用途，
release 签署和应用商店上架由应用维护者处理。真机还须覆盖登录/联网对战、
触摸拖放、旋转/切边、Spine/WASM、音频、后台恢复和长时间内存表现。

## 验证

```powershell
node --test D:\Github\cocos4\tools\devkit\test\android-export.test.mjs `
  D:\Github\cocos4\tools\devkit\test\android-templates.test.mjs `
  D:\Github\cocos4\tools\devkit\test\android-direct-build.test.mjs `
  D:\Github\cocos4\tools\devkit\test\android-cli.test.mjs `
  D:\Github\cocos4\tools\devkit\test\android-hosting.test.mjs
```

`android-hosting.test.mjs` 使用真实原始 socket 验证两种托管模式的省略/打包、
握手、Origin 转发、ping/pong 转发、关闭码与畸形帧（非规范长度、保留位、
错误 UTF-8、超限、非法 close、游离 continuation）；设置
`COCOS4_ANDROID_TEST_JAVA_HOME` 后编译生成的 HostWebSocket 并在桌面 JVM
运行，`javap` 断言 bridge 方法面；同时设置 `COCOS4_ANDROID_TEST_SDK` 后还会
实建 lan-host debug APK（含适配器资源与宿主 Java）。

Windows 上把测试/构建工作目录固定在 D 盘可设置
`COCOS4_ANDROID_TEST_WORK_ROOT`（例如
`D:\cocos4-work\android-hosting-max-tests`）；未设置时各套件使用仓库内的
`tools/devkit/build/android-*-tests` 作为默认父目录，Linux CI 不需要该变量。
测试进程的 `TEMP/TMP/TMPDIR` 也应在 Windows 指向 D 盘。仓库内的
`D:\cocos4-work\devkit-win32-run9` 是完整性保护的只读发布包，任何测试都不得写入。

模板测试可选读取 `COCOS4_ANDROID_TEST_JAVA_HOME` 和
`COCOS4_ANDROID_TEST_ANDROID_JAR`，使用真实 Android API 编译生成 Java 并运行
资源路径/Range/MIME/流测试；没有外部 SDK 时明确跳过这一集成测试。
再设置 `COCOS4_ANDROID_TEST_SDK` 可实建、验签 debug APK，验证同签名更新和
unsigned release。默认实际编译平台 36、build-tools 36.0.0，可由
`COCOS4_ANDROID_TEST_PLATFORM`/`COCOS4_ANDROID_TEST_BUILD_TOOLS` 指定已装版本。
静态导出检查和项目生成不表示 APK 已构建，APK 已构建也不表示真机渲染通过。
