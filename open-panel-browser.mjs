// Codex 任务面板 · 浏览器模式启动器
//
// 双击桌面快捷方式后：
//   1. 如果面板引擎已在运行（固定地址可访问）→ 直接打开默认浏览器
//   2. 否则 → 清理旧引擎（不开、也不关 Codex 窗口）→ 后台静默启动引擎 → 打开默认浏览器
//
// 特性：
//   - 不打开任何 Codex 窗口（跑任务用的是 Codex 后端 CLI，无需窗口）
//   - 面板地址永久固定（见 panel-config.mjs），浏览器书签一次永久有效
//   - 数据与 Codex 模式完全同源（同一个 SQLite 库，任务互通）
//
// 可选参数：--no-open   只启动引擎不打开浏览器（调试用）

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PANEL_PORT, PANEL_TOKEN, PANEL_ORIGIN, PANEL_URL } from "./panel-config.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const nodeExe = process.execPath;
const dataDir = path.join(projectRoot, ".data");
const secretFile = path.join(dataDir, "browser-mode-secret");
const runtimeFile = path.join(dataDir, "launcher-runtime.json");
const noOpen = process.argv.includes("--no-open");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(msg);

// ---------------------------------------------------------------- Codex CLI
// 面板跑任务用的是 Codex 后端（codex.exe app-server），不依赖 Codex 桌面窗口。
// Windows Store 版 Codex 会自动更新，版本号会变，必须动态解析。
function resolveCodexCli() {
  const appx = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | ForEach-Object { $_.InstallLocation }",
    ],
    { encoding: "utf8" },
  );
  const installLocation = (appx.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (installLocation) {
    const cli = path.join(path.dirname(path.join(installLocation, "app", "ChatGPT.exe")), "resources", "codex.exe");
    if (existsSync(cli)) return cli;
  }
  return null;
}

// ---------------------------------------------------------------- 实例密钥
// 服务端要求实例令牌存在时必须同时提供密钥（hex，32~128 位）。
// 持久化到 .data，重启引擎后密钥不变，已打开的浏览器页面不会掉线。
function loadOrCreateSecret() {
  try {
    const existing = readFileSync(secretFile, "utf8").trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing;
  } catch { /* 不存在则创建 */ }
  const secret = randomBytes(32).toString("hex");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

// ---------------------------------------------------------------- 探活
async function panelAlive() {
  try {
    const res = await fetch(PANEL_URL, { redirect: "follow" });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 清理旧引擎
const taskkill = (pid, tree = false) =>
  spawnSync("taskkill.exe", tree ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/F"], { stdio: "ignore" });

const listNodeProcesses = (pattern) => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" } | Where-Object { $_ -match '${pattern}' }`,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const pid = Number(l.split(/\s+/)[0]);
      return Number.isInteger(pid) ? pid : null;
    })
    .filter(Boolean);
};

const portListenerPids = () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${PANEL_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { "$($_.OwningProcess) x" }`,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return [];
  return [...new Set(result.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => Number(l.split(/\s+/)[0])).filter(Number.isInteger))];
};

async function killStaleEngine() {
  // 顺序很重要：
  //   1) 先杀注入器 —— 它的 supervisor 会自动复活面板服务，不先杀它会端口抢回去
  //      （只杀进程本身，不带 /T，避免误杀它拉起的 Codex 窗口）
  //   2) 再杀 launch-panel 宿主
  //   3) 杀掉所有孤儿 server/index.mjs —— 它们握着 SQLite 数据库锁，
  //      不杀的话新引擎会因数据库被锁而反复崩溃退出（实测踩过的坑）
  //   4) 最后清 47823 端口占用（带 /T，连它的 codex app-server 工作进程一起收）
  // 注意：绝不动 proxy-manager（Codex 窗口里的模型切换器依赖它）
  const injectorPids = listNodeProcesses("codex-injector");
  for (const pid of injectorPids) taskkill(pid);
  const hostPids = listNodeProcesses("launch-panel");
  for (const pid of hostPids) taskkill(pid);
  if (injectorPids.length || hostPids.length) await sleep(2000);

  const orphanServerPids = listNodeProcesses("server[\\\\/]{0,2}index[.]mjs").filter((pid) => pid !== process.pid);
  for (const pid of orphanServerPids) taskkill(pid, true);
  if (orphanServerPids.length) await sleep(1500);

  for (let round = 1; round <= 5; round++) {
    const pids = portListenerPids();
    if (!pids.length) return true;
    log(`      第 ${round} 轮：清理端口占用（${pids.length} 个进程）`);
    for (const pid of pids) taskkill(pid, true);
    await sleep(2000);
  }
  return portListenerPids().length === 0;
}

// ---------------------------------------------------------------- 启动引擎
function startEngine() {
  const cli = resolveCodexCli();
  const child = spawn(nodeExe, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: String(PANEL_PORT),
      CODEX_TASKBOARD_INSTANCE_TOKEN: PANEL_TOKEN,
      CODEX_TASKBOARD_INSTANCE_SECRET: loadOrCreateSecret(),
      ...(cli ? { CODEX_EXECUTABLE: cli } : {}),
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
  });
  child.unref();
  return child.pid;
}

function writeRuntime(serverPid) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      runtimeFile,
      `${JSON.stringify({ version: 1, pid: serverPid, url: `${PANEL_ORIGIN}/${PANEL_TOKEN}` })}\n`,
      { mode: 0o600 },
    );
  } catch { /* 非关键路径 */ }
}

// ---------------------------------------------------------------- 打开浏览器
function openBrowser(url) {
  spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
}

// ---------------------------------------------------------------- 主流程
log("Codex 任务面板 · 浏览器模式");
log("");

if (await panelAlive()) {
  log("引擎已在运行，直接打开面板");
} else {
  log("正在后台启动面板引擎（不开 Codex 窗口）...");
  const released = await killStaleEngine();
  if (!released) {
    log("端口 " + PANEL_PORT + " 未能释放，稍后重试或告诉我处理");
    process.exit(1);
  }
  const serverPid = startEngine();

  let ready = false;
  for (let attempt = 1; attempt <= 40; attempt++) {
    await sleep(1000);
    if (await panelAlive()) { ready = true; break; }
  }
  if (!ready) {
    log("引擎启动超时（40 秒未就绪），请把下面的信息告诉我排查：");
    log(`  端口 ${PANEL_PORT} 占用进程: ${portListenerPids().join(", ") || "无"}`);
    process.exit(1);
  }
  writeRuntime(serverPid);
  log("引擎已就绪（PID " + serverPid + "）");
}

if (!noOpen) {
  openBrowser(PANEL_URL);
  log("已用默认浏览器打开面板");
}
log("");
log("面板地址（永久固定）: " + PANEL_URL);
process.exit(0);
