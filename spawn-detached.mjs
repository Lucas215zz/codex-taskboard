// 脱离式进程启动器：绕开 PowerShell 5.1 Start-Process 的环境变量字典 bug。
//
// 背景：本机环境同时存在 HTTP_PROXY/http_proxy、HTTPS_PROXY/https_proxy 等
// 大小写重复变量时，Start-Process 构建 ProcessStartInfo.EnvironmentVariables
// 会抛「已添加项。字典中的关键字:"HTTPS_PROXY"」，注入器/代理根本起不来。
// node 的 spawn 直接复制原始环境块（保留重复键），天然免疫这个问题。
//
// 用法：node spawn-detached.mjs <相对脚本路径> [参数...]
// 行为：detached + stdio 重定向到 .data/single-injector.log(.err)（追加模式，
//       文件被占用也不报错），启动完打印子进程 PID 后立即退出。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error("用法: node spawn-detached.mjs <相对脚本路径> [参数...]");
  process.exit(1);
}

const dataDir = path.join(PROJECT_ROOT, ".data");
fs.mkdirSync(dataDir, { recursive: true });
const out = fs.openSync(path.join(dataDir, "single-injector.log"), "a");
const err = fs.openSync(path.join(dataDir, "single-injector.log.err"), "a");

const child = spawn(
  process.execPath,
  [path.join(PROJECT_ROOT, script), ...rest],
  {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    detached: true,
    stdio: ["ignore", out, err],
  },
);
child.unref();
console.log(child.pid);
