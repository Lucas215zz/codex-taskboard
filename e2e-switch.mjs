// 端到端：点选原生菜单里的模型 -> 验证 model + model_provider 都落盘
//
// 匹配策略与 codex-model-switcher.user.js 保持一致：
//   菜单项 DOM 里没有 slug，只有 Codex 美化过的显示名，
//   所以用「文本变体匹配 -> 显示名匹配 -> 索引匹配」三级回退。
//   索引匹配依据：model/list 的返回顺序 == 菜单项渲染顺序（实测一致）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG = path.join(os.homedir(), ".codex", "config.toml");

const port = 9231;
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url === "app://-/index.html");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = (expr) => send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
const val = (r) => r?.result?.result?.value;

function readConfig() {
  const t = fs.readFileSync(CONFIG, "utf8");
  const g = (k) => (t.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m")) || [])[1];
  return { model: g("model"), provider: g("model_provider") };
}

const target = process.argv[2] || "MiniMax-M3.1-Flash";
const expectProvider = process.argv[3] || "minimax";

// ---- 拉取权威模型目录
const catalog = JSON.parse(val(await ev(`(async () => {
  const rid = "e2e-" + Date.now().toString(36);
  const res = await new Promise((resolve) => {
    const on = (ev) => {
      const m = ev.data;
      if (m && m.type === "mcp-response" && m.message && m.message.id === rid) {
        ev.stopImmediatePropagation();
        resolve(m.message);
      }
    };
    addEventListener("message", on, true);
    setTimeout(() => resolve({ error: { message: "timeout" } }), 10000);
    window.electronBridge.sendMessageFromView({
      type: "mcp-request", hostId: "local",
      request: { id: rid, method: "model/list", params: { includeHidden: true } },
      priority: "interactive", source: "e2e", timeoutMs: 10000, expiresAtMs: Date.now() + 10000,
    });
  });
  const d = res.result?.data || [];
  return JSON.stringify(d.map((m) => ({ id: m.id, displayName: m.displayName || m.id })));
})()`)));
console.log("模型目录:", catalog.length, "个");

console.log("=== 切换前 ===", JSON.stringify(readConfig()));

await ev(`(() => {
  const btn=[...document.querySelectorAll('button,[role=button]')].find(b=>/推理强度/.test(b.textContent||''));
  btn?.click(); return 'opened';
})()`);
await new Promise((r) => setTimeout(r, 1500));

console.log("点击:", val(await ev(`(() => {
  const items=[...document.querySelectorAll('[role=menuitemradio]')];
  const text=(it)=>(it.textContent||'').trim();
  const norm=(s)=>s.trim().toLowerCase().replace(/\\s+/g,'');
  const target=${JSON.stringify(target)};
  const cat=${JSON.stringify(catalog)};

  // 1) 文本变体匹配
  const stripped=target.replace(/^gpt-/,'');
  const base=stripped.replace(/-wb$/,'');
  const variants=[norm(target),norm(stripped),norm(base+' (wb)'),norm(target.replace(/-wb$/,'')+' (wb)')];
  for(const it of items){ if(variants.includes(norm(text(it)))){ it.click(); return 'clicked(text) '+text(it); } }

  // 2) 显示名匹配
  const entry=cat.find(m=>m.id===target);
  if(entry){
    const dn=norm(entry.displayName), dns=norm(entry.displayName.replace(/^gpt-/,''));
    for(const it of items){ const t=norm(text(it)); if(t===dn||t===dns){ it.click(); return 'clicked(display) '+text(it); } }
  }

  // 3) 索引匹配：菜单顺序 == model/list 顺序
  const catIdx=cat.findIndex(m=>m.id===target);
  if(catIdx>=0){
    const cands=items.filter(it=>{const t=norm(text(it)); return t && t!==norm('默认推荐模型集');});
    if(cands[catIdx]){ cands[catIdx].click(); return 'clicked(index) '+text(cands[catIdx]); }
  }

  return 'NOT FOUND: ' + items.map(text).join(' | ');
})()`)));

await new Promise((r) => setTimeout(r, 3500));

const after = readConfig();
console.log("=== 切换后 ===", JSON.stringify(after));
const okModel = after.model === target;
const okProvider = after.provider === expectProvider;
console.log(`${okModel ? "✅" : "❌"} model = ${after.model} (期望 ${target})`);
console.log(`${okProvider ? "✅" : "❌"} model_provider = ${after.provider} (期望 ${expectProvider})`);

console.log("菜单选中:", val(await ev(`(() => {
  const items=[...document.querySelectorAll('[role=menuitemradio]')];
  return JSON.stringify(items.filter(i=>i.getAttribute('aria-checked')==='true').map(i=>(i.textContent||'').trim()));
})()`)));

ws.close();
process.exit(okModel && okProvider ? 0 : 1);
