// 规范化 .cmd 文件：GBK + CRLF
// 用途：Windows 的 .cmd 双击执行要求 GBK 编码 + CRLF 换行，
// UTF-8 或 LF 会导致双击「没反应」。
//
// 用法：node fix-cmd-encoding.mjs <文件...>
// 处理流程：按当前实际编码读入 -> 统一成 UTF-8 内存态 -> 规范 CRLF -> 写回 GBK
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function detectDecode(buf) {
  // 先试 UTF-8（严格）
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text: buf.toString("utf8"), was: "utf8" };
  } catch {
    // 再试 GBK
    const r = spawnSync("iconv", ["-f", "GBK", "-t", "UTF-8"], {
      input: buf,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout) {
      return { text: r.stdout.toString("utf8"), was: "gbk" };
    }
  }
  // 兜底：latin1（纯 ASCII 场景）
  return { text: buf.toString("latin1"), was: "latin1" };
}

function toGbk(text) {
  for (const enc of ["gbk", "gb18030"]) {
    const r = spawnSync("iconv", ["-f", "UTF-8", "-t", enc], {
      input: text,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout && r.stdout.length) return r.stdout;
  }
  return null;
}

for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const { text, was } = detectDecode(buf);

  let normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  if (normalized.charCodeAt(0) === 0xfeff) normalized = normalized.slice(1);

  const gbk = toGbk(normalized);
  if (!gbk) {
    console.error(`❌ ${file} GBK 转换失败`);
    continue;
  }
  fs.writeFileSync(file, gbk);

  const check = fs.readFileSync(file);
  let stillUtf8 = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(check);
  } catch {
    stillUtf8 = false;
  }
  const s = check.toString("latin1");
  const crlf = (s.match(/\r\n/g) || []).length;
  const bareLf = (s.replace(/\r\n/g, "").match(/\n/g) || []).length;

  console.log(
    `✅ ${file}\n` +
    `   原编码: ${was} -> GBK | CRLF: ${crlf} 行 | 裸 LF: ${bareLf} 行 | ` +
    `UTF-8 残留: ${stillUtf8 ? "❌有" : "✅无"}`,
  );
}
