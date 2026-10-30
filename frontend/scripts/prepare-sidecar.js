"use strict";

// electron-builder 只会把存在的目录打进 resources/。
// 这里先把 dist/SubtitleSidecar 拷到 frontend/build-sidecar，缺失时直接报错，
// 免得打出一个"能开界面但识别永远失败"的安装包。

const fs = require("fs");
const path = require("path");

const source = path.resolve(__dirname, "..", "..", "dist", "SubtitleSidecar");
const target = path.resolve(__dirname, "..", "build-sidecar");

if (!fs.existsSync(source)) {
  console.error(`[prepare-sidecar] 找不到后端目录：${source}`);
  console.error("请先在仓库根目录运行 build_sidecar_windows.bat，再执行 npm run pack / npm run dist。");
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log(`[prepare-sidecar] ${source} -> ${target}`);
