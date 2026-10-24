// Codex 任务面板启动器（Node 版，避免 PowerShell/cmd 的引号与编码坑）
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PANEL_TOKEN } from "./panel-config.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const nodeExe = process.execPath;
// 用户目录跟着当前用户走，不要硬编码 C:\Users\phlus
const profileDir = path.join(os.homedir(), "AppData", "Roaming", "codex-taskboard-profile");
const cdpPort = 9231;
const servicePort = 47823;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(msg);

// ---------------------------------------------------------------- Codex 路径
// 不能硬编码版本号：Windows Store 版 Codex 会自动更新，
// 路径里的版本段（如 26.1013.4894.0）一变，ChatGPT.exe 路径就失效。
// 优先用 AppX 包信息动态解析，查不到再退回 WindowsApps 目录扫描。
function resolveCodexApp() {
  // 1) AppX 包信息（最准）
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
    const exe = path.join(installLocation, "app", "ChatGPT.exe");
    if (existsSync(exe)) return exe;
  }

  // 2) 扫描 WindowsApps 目录（AppX 查询失败时兜底）
  const windowsApps = "C:\\Program Files\\WindowsApps";
  try {
    const candidates = readdirSync(windowsApps)
      .filter((name) => name.startsWith("OpenAI.Codex_"))
      .sort()
      .reverse();
    for (const name of candidates) {
      const exe = path.join(windowsApps, name, "app", "ChatGPT.exe");
      if (existsSync(exe)) return exe;
    }
  } catch {
    // 目录无权限，忽略
  }

  return null;
}

const codexApp = resolveCodexApp();

function line(char = "=") {
  log(char.repeat(46));
}

// ---------- 清理阶段 ----------
line();
log("  Codex 任务面板启动器");
line();
log("");

if (!codexApp) {
  log("  [错误] 找不到 Codex 应用（ChatGPT.exe）");
  log("          请确认 Microsoft Store 版 Codex 已安装。");
  log("");
  process.exit(1);
}
log("  Codex 路径: " + codexApp);
log("");

// 1. 停掉旧注入器
const taskkill = (pid) => spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
const listProcesses = (filter) => {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", filter],
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

log("[1/6] 清理旧的注入器进程...");
const injectorPids = listProcesses(
  "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" } | Where-Object { $_ -match 'codex-injector|proxy-manager' }",
);
for (const pid of injectorPids) taskkill(pid);
if (injectorPids.length) await sleep(2000);
log(`      完成（发现 ${injectorPids.length} 个）`);

// 2. 关掉所有 Codex
log("[2/6] 关闭已有 Codex 窗口...");
const codexPids = listProcesses(
  "Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" } | Where-Object { $_ -notmatch '--type=' }",
);
if (codexPids.length) {
  for (const pid of codexPids) taskkill(pid);
  await sleep(3000);
}
log(`      完成（关闭 ${codexPids.length} 个）`);

// 3. 释放服务端口
// 注意：不能只杀一次就走。注入器被 kill 后，它的子进程（taskboard 服务）
// 可能还占着 47823 端口，导致新服务 EADDRINUSE 起不来。
// 这里循环「查占用 -> 杀 -> 再查」直到端口真的空出来。
log("[3/6] 释放面板服务端口...");
{
  let released = false;
  for (let round = 1; round <= 5; round++) {
    const portPids = listProcesses(
      `Get-NetTCPConnection -LocalPort ${servicePort} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { "$($_.OwningProcess) x" }`,
    );
    if (!portPids.length) {
      released = true;
      break;
    }
    log(`      第 ${round} 轮：发现 ${portPids.length} 个占用进程，杀掉`);
    for (const pid of portPids) taskkill(pid);
    await sleep(2500);
  }
  log(released ? "      完成（端口已释放）" : "      ⚠️  端口仍被占用，新面板服务可能启动失败");
}

// 4. 同步 WorkBuddy 自定义模型到 Codex（目录 + provider + 映射）
log("[4/6] 同步 WorkBuddy 自定义模型到 Codex...");
{
  const sync = spawnSync(nodeExe, [path.join(projectRoot, "sync-codex-models.mjs")], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 30000,
  });
  const out = ((sync.stdout || "") + (sync.stderr || "")).trim();
  if (sync.status === 0) {
    const line = out.split("\n").find((l) => l.includes("->")) || out.split("\n")[1] || "已同步";
    log("      " + line.trim());
  } else {
    log("      ⚠️  同步失败（不影响面板启动）: " + (out.split("\n").slice(-1)[0] || "").trim());
  }
}

// 5. 启动协议代理
//
// Codex 只支持 wire_api = "responses"（官方已移除 chat 支持），
// 但部分 WorkBuddy 服务商只提供 /chat/completions。
// 代理管理器会逐个探测，必要时起一个本地 Responses->Chat 转换代理，
// 并把 config.toml 里的 base_url 指向本地代理。
log("[5/6] 检测服务商协议兼容性并启动代理...");
{
  const proxy = spawn(nodeExe, [path.join(projectRoot, "proxy-manager.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      // 本地代理必须绕过系统 HTTP(S)_PROXY，否则请求会被转发出网
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let proxyOut = "";
  proxy.stdout.on("data", (d) => { proxyOut += d.toString(); });
  proxy.stderr.on("data", (d) => { proxyOut += d.toString(); });

  // 等代理管理器完成探测并写好 config.toml（最多 60 秒）
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    if (proxyOut.includes("config.toml 已更新")) { ready = true; break; }
    if (proxy.exitCode !== null) break;
  }
  for (const l of proxyOut.split("\n")) {
    if (l.trim() && !l.includes("config.toml 已更新")) log("      " + l.trim());
  }
  if (ready) {
    const summary = proxyOut.split("\n").find((l) => l.includes("=direct") || l.includes("=proxy"));
    log("      " + (summary ? summary.trim() : "代理已就绪"));
  } else {
    log("      ⚠️  代理管理器未就绪（不影响面板启动）");
  }
  proxy.on("exit", (code) => {
    if (code !== 0) log(`  ⚠️  代理进程退出（代码 ${code}）`);
  });
}

// ---------- 启动阶段 ----------
log("[6/6] 启动注入器与带面板的 Codex...");
log("");
log("  >> 会出现一个 Codex 窗口，左侧栏找 Taskboard 图标");
log("  >> 本窗口是引擎，请保持运行");
log("");

const injector = spawn(
  nodeExe,
  [
    path.join(projectRoot, "scripts", "codex-injector.mjs"),
    "--launch",
    "--watch",
    "--open",
    "--port",
    String(cdpPort),
    "--app-path",
    codexApp,
  ],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_CODEX_PROFILE: profileDir,
      // 固定实例令牌：Codex 模式与浏览器模式共用同一个面板地址
      CODEX_TASKBOARD_INSTANCE_TOKEN: PANEL_TOKEN,
      // 把当前 node 所在目录加进 PATH，子进程才能找到 node。
      // 不要再硬编码某个版本的路径 —— node 版本升级后路径会变。
      PATH: `${path.dirname(nodeExe)}${path.delimiter}${process.env.PATH || ""}`,
    },
    stdio: "inherit",
  },
);

injector.on("exit", (code) => {
  log("");
  log(`面板服务已退出（代码 ${code}）。按任意键关闭此窗口。`);
  process.stdin.resume();
  process.stdin.once("data", () => process.exit(0));
});

// ---------- 面板就绪检查 ----------
log("");
log("正在等待 Codex 窗口并挂载面板...");
let panelReady = false;
for (let attempt = 1; attempt <= 12; attempt++) {
  await sleep(5000);
  const refresh = spawnSync(nodeExe, [path.join(projectRoot, "refresh-panel.mjs")], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 30000,
  });
  const output = (refresh.stdout || "").trim();
  if (output) log(output);
  if (refresh.status === 0) {
    panelReady = true;
    break;
  }
}

if (panelReady) {
  log("");
  log("  [OK] 面板已挂载。左侧栏找 Taskboard 图标即可使用。");
} else {
  log("");
  log("  [提示] 面板可能需要再点一次侧边栏图标，或稍等几秒重试。");
}

// ---------- 模型切换器注入 ----------
log("");
log("正在注入多模型切换器...");
{
  const inject = spawnSync(nodeExe, [path.join(projectRoot, "inject-model-switcher.mjs")], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, CODEX_TASKBOARD_CDP_PORT: String(cdpPort) },
  });
  const out = ((inject.stdout || "") + (inject.stderr || "")).trim();
  for (const l of out.split("\n")) if (l.trim()) log("  " + l.trim());
  if (inject.status !== 0) {
    log("  ⚠️  模型切换器注入失败，可手动运行 inject-model-switcher.mjs 重试");
  }
}

try {
  const runtime = JSON.parse(
    readFileSync(path.join(projectRoot, ".data", "launcher-runtime.json"), "utf8"),
  );
  log("");
  log("  浏览器直接打开: " + runtime.url);
} catch {
  // 忽略：地址文件可能还没生成
}
