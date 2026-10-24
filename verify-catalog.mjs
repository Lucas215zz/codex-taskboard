// 验证真实配置下的 model/list 是否包含自定义模型
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Codex 路径动态解析（Store 版会自动更新，硬编码版本号会失效）
function resolveCodexExe() {
  if (process.env.CODEX_EXE && fs.existsSync(process.env.CODEX_EXE)) {
    return process.env.CODEX_EXE;
  }
  try {
    const ps = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command",
       "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation"],
      { encoding: "utf8", timeout: 20000 },
    );
    const loc = (ps.stdout || "").trim().split(/\r?\n/).filter(Boolean)[0];
    if (loc) {
      const exe = path.join(loc, "app", "resources", "codex.exe");
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* ignore */ }
  try {
    const r = spawnSync("where", ["codex.exe"], { encoding: "utf8" });
    const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* ignore */ }
  return null;
}

const CODEX = resolveCodexExe();
if (!CODEX) {
  console.error("找不到 codex.exe。请设置环境变量 CODEX_EXE。");
  process.exit(1);
}
const p = spawn(CODEX, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const pending = new Map(); let err = "";
p.stdout.setEncoding("utf8");
p.stdout.on("data", (c) => {
  buf += c; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
p.stderr.on("data", (d) => { err += String(d); });
let seq = 0;
const send = (method, params) => {
  const id = `v-${++seq}`;
  const pr = new Promise((res) => { pending.set(id, res); setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: "timeout" } }); } }, 20000); });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return pr;
};
await send("initialize", { clientInfo: { name: "v", title: "v", version: "1" } });
await send("initialized", {});

const ml = await send("model/list", { includeHidden: true });
const data = ml.result?.data || [];
console.log("model/list 总数:", data.length);
console.log("--- 全部 ---");
for (const m of data) {
  console.log(`  ${m.id.padEnd(28)} ${m.displayName.padEnd(28)} hidden=${m.hidden} default=${m.isDefault}`);
}
const custom = ["claude-opus-4-7", "gpt-5.5", "glm-5.3-flashx", "MiniMax-M3", "MiniMax-M3.1-Flash"];
console.log("--- 自定义模型命中 ---");
for (const c of custom) {
  const hit = data.find((m) => m.id === c);
  console.log(`  ${hit ? "✅" : "❌"} ${c}${hit ? ` (efforts: ${(hit.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).join("/")})` : ""}`);
}
if (/as JSON/.test(err)) console.log("目录解析错误:", err.match(/as JSON: [^\n]+/)[0]);
p.kill();
process.exit(0);
