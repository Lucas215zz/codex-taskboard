// 重新触发 Codex 内的任务面板加载（首次注入后 iframe 偶尔会卡在「正在启动…」）
const port = process.env.CODEX_TASKBOARD_CDP_PORT || "9231";

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && t.url === "app://-/index.html");
if (!page) {
  console.error("未找到 Codex 主页面");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
function send(expression) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true },
    }));
  });
}

await send("window.__codexTaskboardInjection__?.close?.(); window.__codexTaskboardInjection__?.open?.(); 'reopen'");
await new Promise((resolve) => setTimeout(resolve, 4000));

const result = await send(
  "JSON.stringify({ ready: window.__codexTaskboardInjection__?.ready ?? null, status: document.querySelector('#codex-taskboard-page [role=status]')?.textContent ?? null, statusHidden: document.querySelector('#codex-taskboard-page [role=status]')?.hidden ?? null })",
);
const state = JSON.parse(result.result?.result?.value || "{}");
console.log("面板状态:", JSON.stringify(state));
ws.close();
process.exit(state.ready && state.statusHidden ? 0 : 1);
