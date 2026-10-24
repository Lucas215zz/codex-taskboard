// 注入模型切换器到 Codex 渲染进程，并校验模型目录是否生效
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.CODEX_TASKBOARD_CDP_PORT || "9231";
const scriptPath = path.join(projectRoot, "codex-model-switcher.user.js");
const source = readFileSync(scriptPath, "utf8");

// 读取模型->provider 映射（由 sync-codex-models.mjs 生成），动态注入避免硬编码过期
let providerMap = {};
try {
  const raw = JSON.parse(readFileSync(path.join(projectRoot, "model-provider-map.json"), "utf8"));
  providerMap = Object.fromEntries(raw.map((m) => [m.id, m.provider]));
} catch {
  console.warn("⚠️  未找到 model-provider-map.json，使用脚本内置默认映射");
}

// 读取本地模型目录（含 display_name），用于区分官方模型与 WorkBuddy 自定义模型
let catalog = [];
try {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const raw = JSON.parse(readFileSync(path.join(home, ".codex", "model-catalog.json"), "utf8"));
  catalog = (raw.models || []).map((m) => ({ id: m.slug, displayName: m.display_name }));
} catch {
  console.warn("⚠️  未找到 model-catalog.json，自定义模型分组可能不准确");
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const pages = targets.filter((t) => t.type === "page" && t.url.startsWith("app://-/index.html"));
if (!pages.length) {
  console.error("未找到 Codex 主页面，请先启动 Codex");
  process.exit(1);
}

const page = pages.find((t) => t.url === "app://-/index.html") || pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params) {
  return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value;
};

// 先清掉旧版本标记，保证热更新生效
await ev(`(() => { window.__codexModelSwitcherV2 = false; window.__codexModelSwitcherInstalled = false; return 1; })()`);

// 注入最新的模型->provider 映射与模型目录（在脚本执行前写入全局变量）
await ev(
  `(() => {
    window.__codexProviderMap = ${JSON.stringify(providerMap)};
    window.__codexCatalog = ${JSON.stringify(catalog)};
    return 1;
  })()`,
);

const result = await send("Runtime.evaluate", { expression: source, returnByValue: true });
if (result.exceptionDetails) {
  console.error("注入失败:", result.exceptionDetails.exception?.description?.slice(0, 400));
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 1500));

const check = await ev(`JSON.stringify({
  installed: !!window.__codexModelSwitcherV2,
  hasStyle: !!document.getElementById("codex-model-switcher-v2-style"),
})`);
console.log("注入结果:", check);

// 校验模型目录是否已被 Codex 识别
const models = await ev(`(async () => {
  const requestId = "vfy-" + Date.now().toString(36);
  const res = await new Promise((resolve) => {
    const onMsg = (ev) => {
      const m = ev.data;
      if (!m || m.type !== "mcp-response") return;
      if (m.message?.id !== requestId) return;
      ev.stopImmediatePropagation();
      resolve(m.message);
    };
    const timer = setTimeout(() => resolve({ error: { message: "timeout" } }), 10000);
    addEventListener("message", onMsg, true);
    window.electronBridge.sendMessageFromView({
      type: "mcp-request", hostId: "local",
      request: { id: requestId, method: "model/list", params: { includeHidden: true } },
      priority: "interactive", source: "verify", timeoutMs: 10000, expiresAtMs: Date.now() + 10000,
    }).catch((e) => resolve({ error: { message: String(e) } }));
  });
  const data = res.result?.data || [];
  return JSON.stringify({ count: data.length, ids: data.map((m) => m.id) });
})()`);
try {
  const parsed = JSON.parse(models);
  console.log("模型目录:", parsed.count, "个 ->", parsed.ids.join(", "));
  const custom = ["claude-opus-4-7", "glm-5.3-flashx", "MiniMax-M3", "MiniMax-M3.1-Flash", "gpt-5.5-wb", "deepseek-flash"];
  const missing = custom.filter((c) => !parsed.ids.includes(c));
  console.log(missing.length ? "⚠️ 缺少自定义模型: " + missing.join(", ") : "✅ 自定义模型全部就位");
} catch {
  console.log("模型目录: 读取失败", models);
}

ws.close();
process.exit(0);
