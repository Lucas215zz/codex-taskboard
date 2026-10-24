import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const runtimeFile = path.join(projectRoot, ".data", "launcher-runtime.json");

let url = "";
try {
  const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
  url = typeof runtime.url === "string" ? runtime.url.trim() : "";
} catch {
  url = "";
}

if (!url) {
  console.log("面板服务未运行。请先双击桌面上的「启动Codex任务面板」，再点本图标。");
  process.exit(1);
}

console.log(`正在打开任务面板：${url}`);
spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
  detached: true,
  stdio: "ignore",
}).unref();
