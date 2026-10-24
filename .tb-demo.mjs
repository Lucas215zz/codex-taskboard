import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const port = 9231;
const outDir = "C:\\Users\\phlus\\Documents\\日常瞎聊\\taskboard-demo";
mkdirSync(outDir, { recursive: true });

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
for (const t of targets) {
  console.log(`[${t.type}] ${t.id}  title=${(t.title||"").slice(0,60)}  url=${(t.url||"").slice(0,80)}`);
}
