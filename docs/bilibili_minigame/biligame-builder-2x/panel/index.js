// panel/index.js, this filename needs to match the one registered in package.json
function fetchRequest(url, method) {
  return fetch(url, { method })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      let data = await response.text();

      try {
        return {
          data: { code: 0, success: true, data: JSON.parse(data) },
        };
      } catch (error) {
        return { data };
      }
    })
    .catch((error) => {
      console.log("error", error);
      throw new Error("网络异常,请稍后再试 -> " + error);
    });
}

// 递归复制目录的函数
function copyDirectory(srcDir, destDir) {
  // 确保目标目录存在
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // 读取源目录下的所有文件和目录
  const items = fs.readdirSync(srcDir);
  items.forEach((item) => {
    const srcPath = path.join(srcDir, item);
    const destPath = path.join(destDir, item);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      // 如果是目录，则递归复制
      copyDirectory(srcPath, destPath);
    } else {
      // 如果是文件，则直接复制
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

// 写文件
function writeFile(localFilePath, response) {
  fs.writeFileSync(localFilePath, response.data, "utf8");
}

// 清空目录的函数
function clearDirectory(directory) {
  if (fs.existsSync(directory)) {
    const files = fs.readdirSync(directory);
    files.forEach((file) => {
      const filePath = path.join(directory, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        // 如果是目录，则递归删除
        clearDirectory(filePath);
      } else {
        // 如果是文件，则直接删除
        fs.unlinkSync(filePath);
      }
    });
    // 最后删除目录本身
    fs.rmdirSync(directory);
  }
}

const os = require("os");
const { exec } = require("child_process");

function openDirectory(path) {
  const platform = os.platform();

  let cmd = "";
  if (platform === "win32") {
    // Windows
    cmd = `explorer "${path}"`;
  } else if (platform === "darwin") {
    // macOS
    cmd = `open "${path}"`;
  } else if (platform === "linux") {
    // Linux
    cmd = `xdg-open "${path}"`;
  } else {
    console.error("Unsupported platform:", platform);
    return;
  }

  exec(cmd, (err) => {
    if (err) {
      console.error("Failed to open directory:", err);
    }
  });
}

function compareVersions(version1, version2) {
  if (!version1 || !version2) {
    return 0;
  }

  const v1 = version1.split(".").map(Number);
  const v2 = version2.split(".").map(Number);

  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const num1 = v1[i] || 0; // 如果不存在，默认为 0
    const num2 = v2[i] || 0; // 如果不存在，默认为 0

    if (num1 > num2) return 1; // version1 > version2
    if (num2 > num1) return -1; // version2 > version1
  }

  return 0; // 版本号相同
}

const fs = require("fs");
const path = require("path");
// const axios = require("axios");
const { shell } = require("electron");

const EXTENSION_VERSION = "1.0.2";

const HTTP_URL = "https://miniapp.bilibili.com"; //"http://10.19.64.110:3000"; //"http://127.0.0.1:3000"; //https://miniapp.bilibili.com

Editor.Panel.extend({
  // css style for panel
  style: `
    .tips { color: YELLOW; width: 100%; padding-left: 10px  }
    .main-title { padding-left: 10px }
    :host { margin: 5px; }
    h2 { color: #f90; }
    .form-item { display: flex; margin-top: 20px }
    .title { width: 150px; display: block; text-align: center }
    .bili-input { width: 300px; display: block;}
    .log-box {
      background-color: black;
      width: 400px;
      height: 300px;
      overflow-y: scroll;
      overflow-x: hidden;
    }
    .log-item {
      width: 100%;
      color: white;
      font-size: 14px;
      margin-bottom: 10px;
      padding-left: 10px;
      padding-right: 10px;
    }
  `,

  // html template for panel
  template: `
    <h2 class="main-title">bilibili小游戏构建工具</h2>
    <div class="form-item">
      <span class="tips">小贴士: 构建bilibili小游戏前，需要先构建微信小游戏</span>
    </div>
    <hr />
    <div class="form-item"><span class="title">小游戏AppId</span><ui-input class="bili-input" id="appIdInput"/></div>
    <div class="form-item"><span class="title">小游戏版本号</span><ui-input class="bili-input" id="versionInput"/></div>
    
    <div class="form-item"><span class="title"></span>
        <ui-button id="btn">开始构建</ui-button>
        <ui-button id="btnOpen">打开构建目录</ui-button>
    </div>
    
    <div class="form-item">
      <span class="title">启动首帧图</span>
      <ui-checkbox id="startFrameCheckbox" checked>是</ui-checkbox> <!-- 添加 checked 属性 -->
    </div>

    <div class="form-item" id="imageContainer">
      <span class="title">首帧图片</span>
      <input type="file" class="bili-input" id="imageInput" accept="image/*" />
    </div>

    <div class="form-item" id="adaptationOptions">
      <span class="title">首帧图适配方案</span>
      <label>
        <input type="radio" name="adaptation" value="fullscreen" id="adaptationFullscreen" checked>
        全屏拉满
      </label>
      <label>
        <input type="radio" name="adaptation" value="center" id="adaptationCenter">
        居中显示
      </label>
    </div>


    <div class="form-item">
        <span class="title">构建日志</span>
        <div class="log-box" id="log-box">
          
        </div>
    </div>

    <div class="form-item">
      <span class="title"></span>
      <ui-button id="btnClear">清理日志</ui-button>
    </div>
  `,

  // element and variable binding
  $: {
    btn: "#btn",
    btnClear: "#btnClear",
    label: "#label",
    logBox: "#log-box",
    appIdInput: "#appIdInput",
    versionInput: "#versionInput",
    btnOpen: "#btnOpen",
    imageInput: "#imageInput", // 新增图片输入
    startFrameCheckbox: "#startFrameCheckbox", // 新增首帧图选项
    imageContainer: "#imageContainer", // 新增首帧图选项
    adaptationOptions: "#adaptationOptions",
    adaptationCenter: "#adaptationCenter",
    adaptationFullscreen: "#adaptationFullscreen",
  },

  // method executed when template and styles are successfully loaded and initialized
  ready() {
    const appId = localStorage.getItem("appId");
    const appVersion = localStorage.getItem("appVersion");

    if (appId) {
      this.$appIdInput.value = appId;
    }

    if (appVersion) {
      this.$versionInput.value = appVersion;
    }

    this.$btn.addEventListener("confirm", () => {
      this.onButtonBuild();
    });

    this.$btnClear.addEventListener("confirm", () => {
      this.clearLog();
    });

    this.$btnOpen.addEventListener("confirm", () => {
      this.openBuildDir();
    });

    this.selectedImageFile = null;

    // 处理首帧图选项
    this.$startFrameCheckbox.addEventListener("change", (event) => {
      const isChecked = event.target.checked;
      this.$imageContainer.style.display = isChecked ? "flex" : "none"; // 控制图片选择框的显示
      this.$adaptationOptions.style.display = isChecked ? "flex" : "none"; // 控制图片选择框的显示

      if (!isChecked) {
        this.$imageInput.value = ""; // 如果复选框取消选中，清空选择的图片
      }
      this.addLog(`是否启动首帧图: ${isChecked ? "是" : "否"}`);
    });

    // 处理图片选择
    this.$imageInput.addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) {
        this.selectedImageFile = file; // 保存用户选择的图片文件
        this.addLog(`选择的图片: ${file.name}`);
      }
    });
  },

  addLog(content, isError, isSuccess) {
    const date = new Date();
    const time =
      this.add0ToTime(date.getHours()) +
      ":" +
      this.add0ToTime(date.getMinutes()) +
      ":" +
      this.add0ToTime(date.getSeconds());
    const logItem = document.createElement("div");
    logItem.className = "log-item";
    if (isError) {
      logItem.innerHTML =
        `[${time}]` + " " + `<span style="color: RED">${content}</span>`;
    } else if (isSuccess) {
      logItem.innerHTML =
        `[${time}]` + " " + `<span style="color: GREEN">${content}</span>`;
    } else {
      logItem.innerHTML = `[${time}]` + " " + content;
    }
    this.$logBox.appendChild(logItem);
    logItem.scrollIntoView();
  },

  add0ToTime(time) {
    if (time < 10) {
      time = "0" + time;
    }
    return time;
  },

  clearLog() {
    this.$logBox.innerHTML = "";
  },

  async openBuildDir() {
    const rootPath = Editor.Project.path;
    const buildPath = path.join(rootPath, "./build");

    let isHaveBuildPath = null;

    try {
      isHaveBuildPath = await fs.accessSync(buildPath, fs.constants.F_OK);
      openDirectory(buildPath);
    } catch (error) {
      console.log(error);
      return false;
    }
  },

  async onButtonBuild() {
    this.addLog("开始构建");
    const isContinue = await this.onBeforeBuild();
    if (isContinue) {
      this.onStartBuild();
    }
  },

  async onBeforeBuild() {
    try {
      let res = await fetchRequest(
        `${HTTP_URL}/game-issues/api/issue/getAdaptation/get2XVersion`,
        "get"
      );

      console.log("res", res);
      const orgVersion = res.data.data.version;
      const currVersion = EXTENSION_VERSION;
      this.addLog(`当前插件版本->${currVersion},远程插件版本->${orgVersion}`);

      if (compareVersions(orgVersion, currVersion) == 1) {
        this.addLog("发现新的插件版本");
        // 显示一个对话框提示用户
        const result = await Editor.Dialog.messageBox({
          message: "biligame-builder有新更新，是否前往下载最新版本？",
          buttons: ["继续构建", "停止构建，并前往官网"],
          title: "插件更新提醒",
        });

        if (result === 0) {
          // 用户选择继续，解析 Promise 以继续构建
          this.addLog("继续构建");
          return true;
        } else {
          // 打开默认浏览器并导航到指定URL
          shell.openExternal(
            "https://miniapp.bilibili.com/small-game-doc/guide/compatibility/"
          );
          // 用户选择取消，拒绝 Promise 以阻止构建
          this.addLog("取消操作，构建已停止");
          return false;
        }
      }
      return true;
    } catch (error) {
      this.addLog(error, true);
      return false;
    }
  },

  copyImageToFirstScreen(imageFile, destinationDir) {
    // 确保图片的文件名唯一
    const destPath = path.join(destinationDir, imageFile.name);

    // 使用 fs 直接读取并写入图片到目标目录
    const reader = new FileReader();
    reader.onload = (event) => {
      const imageBuffer = Buffer.from(event.target.result);
      fs.writeFileSync(destPath, imageBuffer); // 写入图片到目标文件夹
      this.addLog(`图片已复制到 ${destPath}`);
    };

    reader.readAsArrayBuffer(imageFile); // 读取图片文件
  },

  async onStartBuild() {
    const rootPath = Editor.Project.path;
    const buildPath = path.join(rootPath, "./build");
    const wechatPath = path.join(buildPath, "./wechatgame");
    const biligamePath = path.join(buildPath, "./biligame");

    let isHaveBuildPath = null;
    let isHaveWechatPath = null;

    try {
      isHaveBuildPath = await fs.accessSync(buildPath, fs.constants.F_OK);
    } catch (error) {
      this.addLog("build 目录不存在, 请先构建微信小游戏, 构建终止", true);
      return false;
    }

    try {
      isHaveWechatPath = await fs.accessSync(wechatPath, fs.constants.F_OK);
    } catch (error) {
      this.addLog("wechatgame 目录不存在, 请先构建微信小游戏, 构建终止", true);
      return false;
    }

    let orgVersion = Editor.remote.App.version;

    this.addLog(`当前引擎版本 ${orgVersion}`);

    try {
      this.addLog(`开始拉取适配文件`);

      // `https://miniapp.bilibili.com/game-issues/api/issue/getAdaptation?version=${orgVersion.slice(
      let res = await fetchRequest(
        `${HTTP_URL}/game-issues/api/issue/getAdaptation/version2x?version=${orgVersion.slice(
          0,
          3
        )}`,
        "get"
      );
      let newRequireStatements = "";
      const data = res.data.data;

      this.addLog(`拉取到了适配文件, ${JSON.stringify(data.files)}`);

      if (data && data.files && data.files.length) {
        // 创建新目录
        if (!fs.existsSync(biligamePath)) {
          this.addLog(`创建biligame目录`);
          fs.mkdirSync(biligamePath, { recursive: true });
        }

        clearDirectory(biligamePath);
        copyDirectory(wechatPath, biligamePath);
        this.addLog(`拷贝原始文件到biligame目录`);

        let fileRes = null;
        let fileName = "";
        for (let i = 0; i < data.files.length; i++) {
          fileName = Object.keys(data.files[i])[0];
          newRequireStatements =
            newRequireStatements + `require('./${fileName}');\n`;
          const localFilePath = path.join(biligamePath, `${fileName}`);

          fileRes = await fetchRequest(data.files[i][fileName], "get");
          console.log("fileRes", fileRes);
          // 把适配文件，写入biligame目录
          writeFile(localFilePath, fileRes);
        }

        this.addLog(`写入适配文件成功！`);

        const destDir = path.join(biligamePath, "."); // 'result.dest' 是构建目录的路径

        // 修改 game.js
        const gameJsPath = path.join(destDir, "game.js");
        let gameJsContent = fs.readFileSync(gameJsPath, "utf8");

        if (compareVersions(orgVersion, "2.3.0") == -1) {
          this.addLog(`引擎版本小于 2.3.x, 使用第1套适配方案`);

          const indexPath = path.join(
            biligamePath,
            "./libs/wrapper/builtin/index.js"
          );
          writeFile(indexPath, "");
          writeFile(indexPath, fileRes);
          this.addLog(`适配文件写入index.js`);
        } else {
          this.addLog(`引擎版本大于 2.3.x, 使用第2套适配方案`);
          const requireText = `require('adapter-min.js');\nrequire('${fileName}');`;
          gameJsContent = gameJsContent.replace(
            "require('adapter-min.js');",
            requireText
          );
        }

        // 下方添加launchSuccess();
        gameJsContent += "\nif(bl){bl.launchSuccess()};";

        // 将新的 require 语句添加到 game.js 的开头
        // gameJsContent = newRequireStatements + gameJsContent;

        // 将修改后的内容写回 game.js
        fs.writeFileSync(gameJsPath, gameJsContent, "utf8");

        this.addLog(`game.js适配成功`);

        const gameJsonPath = path.join(destDir, "game.json");
        let gameJsonContent = fs.readFileSync(gameJsonPath, "utf8");
        let gameJsonFormat = JSON.parse(gameJsonContent);
        if (!gameJsonFormat["appId"]) {
          this.addLog(`正在写入中AppId`);

          localStorage.setItem("appId", this.$appIdInput.value);
          localStorage.setItem("appVersion", this.$versionInput.value);

          gameJsonFormat["appId"] = this.$appIdInput.value;
          gameJsonFormat["version"] = this.$versionInput.value || "1.0.0";
          let newGameJsonContent = JSON.stringify(gameJsonFormat);
          fs.writeFileSync(gameJsonPath, newGameJsonContent, "utf8");
        }

        this.addLog(`game.json适配成功!`);

        const startFrameCheckbox = this.$startFrameCheckbox.checked;
        // 如果复选框选中，则复制目录
        if (startFrameCheckbox) {
          const sourceDir = path.join(
            rootPath,
            "packages/biligame-builder-2x/static",
            "first-screen"
          ); // 使用 process.cwd() 获取当前工作目录
          const destinationDir = path.join(biligamePath, "first-screen");
          const indexPath = path.join(destinationDir, "index.js");

          this.addLog("sourceDir： " + sourceDir);
          if (fs.existsSync(sourceDir)) {
            this.addLog("正在复制首帧图文件夹...");
            copyDirectory(sourceDir, destinationDir);
            this.addLog(`首帧图文件夹已复制到 ${destinationDir}`);

            if (this.selectedImageFile) {
              this.copyImageToFirstScreen(
                this.selectedImageFile,
                destinationDir
              );
              this.updateImagePathInIndexJs(
                indexPath,
                this.selectedImageFile.name
              );
            }
          } else {
            this.addLog("未找到首帧图文件夹，请确认路径是否正确。", true);
            return;
          }

          this.modifyMainJs(biligamePath);
        }

        this.addLog(`bilibili小游戏构建成功!`, false, true);
      }
    } catch (error) {
      console.log("error", error);
      this.addLog(`适配文件下载失败，构建结束`, true);
    }
  },

  updateImagePathInIndexJs(indexPath, imagePath) {
    // 读取 `index.js` 文件内容
    let fileContent = fs.readFileSync(indexPath, "utf8");
    // 替换 `./splash.png` 为新的图片路径
    const updatedContent = fileContent.replace("splash.png", imagePath);
    // 将更新后的内容写回 `index.js` 文件
    fs.writeFileSync(indexPath, updatedContent, "utf8");
    console.log(`index.js 中的图片路径已更新为 ${imagePath}`);
  },

  // 获取首帧图适配方案
  getAdaptationOption() {
    if (this.$adaptationFullscreen.checked) return "fullscreen";
    if (this.$adaptationCenter.checked) return "center";
    return "fullscreen"; // 默认全屏
  },


  modifyMainJs(biligamePath) {
    const mainJsPath = path.join(biligamePath, "main.js");

    // 读取 main.js 文件内容
    let content = fs.readFileSync(mainJsPath, "utf8");

    // 在文件开头添加 require 语句
    const requireStatement = "const firstScreen = require('./first-screen/index');\n";
    content = requireStatement + content;

    // 插入 firstScreen.start('default', 'default') 在 window.boot 函数的起始位置
    const bootStartIndex = content.indexOf("window.boot = function () {");
    if (bootStartIndex !== -1) {
        const insertPosition = bootStartIndex + "window.boot = function () {".length;
        content = content.slice(0, insertPosition) +
            `\n  firstScreen.start('default', 'default', '${this.getAdaptationOption()}');` +
            content.slice(insertPosition);
    }

    // 找到 cc.director.loadScene 及第一个配对的闭合 });
    const loadSceneIndex = content.indexOf("cc.director.loadScene");
    if (loadSceneIndex !== -1) {
        // 找到与 loadScene 语句配对的第一个 `});`
        const endIndex = content.indexOf("});", loadSceneIndex);
        if (endIndex !== -1) {
            // 在 `});` 后面插入 `firstScreen.end();`
            content = content.slice(0, endIndex + 3) +
                `\n  firstScreen.end();` +
                content.slice(endIndex + 3);
        }
    }

    // 写回修改后的 main.js 文件
    fs.writeFileSync(mainJsPath, content, "utf8");
    console.log("main.js 修改成功");
}



});
