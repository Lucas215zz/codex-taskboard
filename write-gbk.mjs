// 把 UTF-8 源文件转成 GBK+CRLF 写入目标路径（Windows .cmd 必须 GBK，否则双击无反应）
// 用法：node write-gbk.mjs <源文件> <目标文件>
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
const dest = process.argv[3];
if (!src || !dest) {
  console.error("用法: node write-gbk.mjs <源文件> <目标文件>");
  process.exit(1);
}

let text = fs.readFileSync(src, "utf8");
// 去掉可能存在的 BOM，统一成 CRLF
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
text = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");

// 用 iconv 子进程做 UTF-8 -> GBK 转换（Node 不内置 GBK 编码器）
import { spawnSync } from "node:child_process";

const encodings = ["gbk", "gb18030", "cp936"];
let converted = null;
for (const enc of encodings) {
  const r = spawnSync("iconv", ["-f", "UTF-8", "-t", enc], {
    input: text,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status === 0 && r.stdout && r.stdout.length) {
    converted = r.stdout;
    break;
  }
}

if (!converted) {
  console.error("GBK 转换失败（iconv 不可用或字符无法转换）");
  process.exit(2);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, converted);

// 自检
const check = fs.readFileSync(dest);
let utf8Valid = true;
try {
  new TextDecoder("utf-8", { fatal: true }).decode(check);
} catch {
  utf8Valid = false;
}
const crlf = (check.toString("latin1").match(/\r\n/g) || []).length;
const bareLf = (check.toString("latin1").replace(/\r\n/g, "").match(/\n/g) || []).length;

console.log(`✅ 已写入 ${dest}`);
console.log(`   编码: ${utf8Valid ? "❌ 仍是 UTF-8" : "✅ GBK"} | CRLF: ${crlf} 行 | 裸 LF: ${bareLf} 行 | 大小: ${check.length}`);
