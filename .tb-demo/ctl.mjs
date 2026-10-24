import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PORT = 9231;
const OUT_DIR = "C:\\Users\\phlus\\Documents\\日常瞎聊\\taskboard-demo";
mkdirSync(OUT_DIR, { recursive: true });

const action = process.argv[2];
const extra = process.argv.slice(3);

async function pickMainPage() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const page = list.find(t =>
    t.type === "page" &&
    typeof t.url === "string" &&
    t.url.startsWith("app://-/index.html") &&
    !t.url.includes("avatar-overlay")
  );
  if (!page) throw new Error("no main page");
  return page;
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function makeSender(ws) {
  let id = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

async function evalExpr(send, expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result?.value;
}

async function screenshot(send, name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  return file;
}

async function mouseClick(send, x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const page = await pickMainPage();
  const ws = await openWs(page.webSocketDebuggerUrl);
  const send = makeSender(ws);
  await send("Page.enable");
  await send("Runtime.enable");

  switch (action) {
    case "info": {
      const info = await evalExpr(send, `JSON.stringify({
        href: location.href,
        iframe: document.querySelector("#codex-taskboard-page iframe")?.src ?? null,
        ready: window.__codexTaskboardInjection__?.ready ?? null,
        inner: { w: innerWidth, h: innerHeight },
        dpr: devicePixelRatio
      })`);
      console.log(info);
      break;
    }
    case "shot": {
      const file = await screenshot(send, extra[0] || "shot");
      console.log(file);
      break;
    }
    case "open-panel": {
      await evalExpr(send, `window.__codexTaskboardInjection__?.open?.()`);
      await sleep(1500);
      const file = await screenshot(send, extra[0] || "panel-opened");
      console.log(file);
      break;
    }
    case "eval": {
      const r = await evalExpr(send, extra.join(" "));
      console.log(typeof r === "string" ? r : JSON.stringify(r));
      break;
    }
    case "click": {
      const [x, y] = extra.map(Number);
      await mouseClick(send, x, y);
      await sleep(500);
      console.log(`clicked ${x},${y}`);
      break;
    }
    case "find-in-iframe": {
      const selector = extra.join(" ");
      const expr = `(() => {
        const frame = document.querySelector("#codex-taskboard-page iframe");
        if (!frame) return JSON.stringify({ error: "no iframe" });
        const fr = frame.getBoundingClientRect();
        const doc = frame.contentDocument;
        if (!doc) return JSON.stringify({ error: "no contentDocument" });
        const el = doc.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ error: "not found" });
        const r = el.getBoundingClientRect();
        return JSON.stringify({
          x: fr.left + r.left,
          y: fr.top + r.top,
          w: r.width, h: r.height,
          text: (el.textContent||"").trim().slice(0,80)
        });
      })()`;
      const out = await evalExpr(send, expr);
      console.log(out);
      break;
    }
    case "iframe-eval": {
      const expr = `(() => {
        const frame = document.querySelector("#codex-taskboard-page iframe");
        if (!frame || !frame.contentWindow) return JSON.stringify({ error: "no iframe" });
        try {
          const r = frame.contentWindow.eval(${JSON.stringify(extra.join(" "))});
          return typeof r === "string" ? r : JSON.stringify(r);
        } catch (e) { return JSON.stringify({ error: String(e) }); }
      })()`;
      const out = await evalExpr(send, expr);
      console.log(out);
      break;
    }
    default:
      console.log("usage: info | shot NAME | open-panel [NAME] | eval EXPR | click X Y | find-in-iframe SEL | iframe-eval EXPR");
  }

  ws.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
