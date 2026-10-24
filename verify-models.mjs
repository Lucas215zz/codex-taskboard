// 真实推理验证：逐个模型跑 codex exec，确认代理链路通
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Codex 路径动态解析：Windows Store 版会自动更新，
// 硬编码版本号（26.1016.6573.0）一更新就失效。
// 注意：C:\Program Files\WindowsApps 普通进程没有读目录权限（EPERM），
// 必须借 PowerShell 的 Get-AppxPackage 取 InstallLocation。
function resolveCodexExe() {
  if (process.env.CODEX_EXE && fs.existsSync(process.env.CODEX_EXE)) {
    return process.env.CODEX_EXE;
  }
  // 1) PowerShell Get-AppxPackage —— 唯一有权限读出 InstallLocation 的路子
  try {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    const loc = (ps.stdout || "").trim().split(/\r?\n/).filter(Boolean)[0];
    if (loc) {
      const exe = path.join(loc, "app", "resources", "codex.exe");
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* ignore */ }
  // 2) 兜底：扫 WindowsApps（部分环境有权限）
  try {
    const windowsApps = "C:\\Program Files\\WindowsApps";
    const candidates = fs
      .readdirSync(windowsApps)
      .filter((d) => d.startsWith("OpenAI.Codex_"))
      .sort()
      .reverse();
    for (const d of candidates) {
      const exe = path.join(windowsApps, d, "app", "resources", "codex.exe");
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* ignore */ }
  // 3) 兜底：which codex
  try {
    const r = spawnSync("where", ["codex.exe"], { encoding: "utf8" });
    const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* ignore */ }
  return null;
}

const CODEX_EXE = resolveCodexExe();
if (!CODEX_EXE) {
  console.error("找不到 codex.exe，无法验证。请设置环境变量 CODEX_EXE。");
  process.exit(1);
}
console.log("codex.exe:", CODEX_EXE, "\n");

const CONFIG = path.join(os.homedir(), ".codex", "config.toml");
const models = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".workbuddy", "models.json"), "utf8"),
);
const map = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "model-provider-map.json"), "utf8"),
);

const original = fs.readFileSync(CONFIG, "utf8");
const results = [];

for (const m of models) {
  const entry = map.find((x) => x.sourceId === m.id && x.provider !== "codex_local_access");
  if (!entry) continue;

  let t = original;
  t = t.replace(/^model\s*=.*$/m, `model = "${m.id}"`);
  t = t.replace(/^model_provider\s*=.*$/m, `model_provider = "${entry.provider}"`);
  t = t.replace(/^model_reasoning_effort\s*=.*$/m, `model_reasoning_effort = "low"`);
  fs.writeFileSync(CONFIG, t);

  const r = await new Promise((resolve) => {
    const child = spawn(CODEX_EXE, ["exec", "--skip-git-repo-check", "Say exactly OK"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.stdin.end();
    const timer = setTimeout(() => { child.kill(); resolve({ out, timeout: true }); }, 130000);
    child.on("close", () => { clearTimeout(timer); resolve({ out, timeout: false }); });
  });

  const hasError = /unexpected status|ERROR:\s*\{"error"|Reconnecting/.test(r.out);
  const ok = !hasError && !r.timeout;
  results.push({ model: m.id, provider: entry.provider, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${m.id.padEnd(20)} provider=${entry.provider}`);
  if (!ok) {
    const em = r.out.match(/ERROR:.{0,160}/);
    console.log("      ", em ? em[0].replace(/\s+/g, " ") : r.timeout ? "timeout" : "unknown");
  }
}

fs.writeFileSync(CONFIG, original);
console.log("\n成功:", results.filter((x) => x.ok).length, "/", results.length);
process.exit(0);
