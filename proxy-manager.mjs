// Chat 协议代理管理器
//
// 作用：为只有 /chat/completions 端点的服务商起一个本地 Responses 代理，
// 并把 Codex 的 model_provider 指向它，让 Codex 能用这些模型。
//
// 判定依据（实测 2026-10-21）：
//   base_url + "/responses" 返回 404/500 not implemented -> 需要代理
//   base_url + "/responses" 返回 200                  -> 直连，不用代理
//
// 用法：node proxy-manager.mjs          启动并写回 config.toml
//       node proxy-manager.mjs --stop   只清理代理配置
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "./responses-chat-proxy.mjs";
import { TokenUsageCollector } from "./server/token-usage.mjs";

// 项目根目录
//
// 注意：必须用 fileURLToPath(import.meta.url)，
// 不能用 new URL(import.meta.url).pathname ——
// 后者返回百分号编码路径，项目目录含中文时（如 E:\github\codex-任务面板插件\...）
// 会得到 %E4%BB%BB%E5%8A%A1... 这种乱码路径。
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const WORKBUDDY_MODELS = path.join(os.homedir(), ".workbuddy", "models.json");
const CODEX_HOME = path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const MAP_PATH = path.join(PROJECT_ROOT, "model-provider-map.json");

// 代理端口段：每个 chat-only provider 一个固定端口
const PROXY_PORTS = {
  kkidc: 48011,
  zhipu: 48012,
  agentaipilot: 48013,
  minimax: 48014,
};

// 已知只支持 chat 的服务商（探测结果不稳定时的兜底）
// 实测：这些服务商的 /responses 端点不存在或返回 not implemented
const KNOWN_CHAT_ONLY = new Set(["kkidc", "zhipu", "agentaipilot"]);

// 已知支持 Responses 的服务商（直连即可，不必探测）
// minimax 的 /v1/responses 稳定返回 200
const KNOWN_RESPONSES = new Set(["minimax"]);

function baseUrlFor(url) {
  return url.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
}

function providerIdFor(url) {
  if (url.includes("agentaipilot.com")) return "agentaipilot";
  if (url.includes("kkidc.com")) return "kkidc";
  if (url.includes("bigmodel.cn")) return "zhipu";
  if (url.includes("minimaxi.com")) return "minimax";
  return null;
}

/**
 * 探测 base_url + /responses 是否可用。
 *
 * 返回三态，因为「明确不支持」和「临时故障」的处理方式完全不同：
 *   "yes"    -> 200，直连即可
 *   "no"     -> 404 / 500 not implemented，协议本身不支持，必须走代理
 *   "maybe"  -> 429 / 502 / 503 / 超时，上游临时问题，走直连（代理反而多一层风险）
 */
async function supportsResponses(baseUrl, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: "probe", input: "hi", store: false }),
    });
    clearTimeout(timer);
    if (r.ok) return "yes";
    const text = await r.text().catch(() => "");
    // 404 / 500 not implemented / 400 -> 协议不支持
    if (r.status === 404 || r.status === 400 || r.status === 501) return "no";
    if (/not implemented|unknown (route|endpoint|path)/i.test(text)) return "no";
    // 429 / 502 / 503 -> 临时故障
    return "maybe";
  } catch {
    clearTimeout(timer);
    return "maybe";
  }
}

export async function startAllProxies({
  log = console.log,
  force = false,
  tokenUsageCollector = new TokenUsageCollector({
    dataDirectory: process.env.CODEX_TASKBOARD_DATA_DIR ?? path.join(PROJECT_ROOT, ".data"),
  }),
} = {}) {
  const models = JSON.parse(fs.readFileSync(WORKBUDDY_MODELS, "utf8"));
  const results = [];

  // 按 provider 分组
  const byProvider = new Map();
  for (const m of models) {
    const pid = providerIdFor(m.url);
    if (!pid) continue;
    if (!byProvider.has(pid)) byProvider.set(pid, { url: m.url, key: m.apiKey });
  }

  for (const [pid, info] of byProvider) {
    const baseUrl = baseUrlFor(info.url);
    // 已知能力的直接用已知结论，避免探测结果随机导致时好时坏
    let support;
    if (KNOWN_RESPONSES.has(pid)) {
      support = "yes";
    } else if (force || KNOWN_CHAT_ONLY.has(pid)) {
      support = "no";
    } else {
      support = await supportsResponses(baseUrl, info.key);
    }

    if (support !== "no") {
      log(`  [直连] ${pid.padEnd(14)} ${baseUrl}`);
      results.push({ provider: pid, mode: "direct", baseUrl });
      continue;
    }

    const port = PROXY_PORTS[pid];
    if (!port) {
      log(`  [跳过] ${pid.padEnd(14)} 没有分配代理端口`);
      results.push({ provider: pid, mode: "direct", baseUrl });
      continue;
    }
    try {
      await startProxy({
        port,
        target: baseUrl,
        key: info.key,
        provider: pid,
        onUsage: (usage) => tokenUsageCollector.recordRelayUsage(usage),
        log: (m) => log(`  [proxy:${pid}] ${m}`),
      });
      log(`  [代理] ${pid.padEnd(14)} http://127.0.0.1:${port}/responses -> ${baseUrl}/chat/completions`);
      results.push({ provider: pid, mode: "proxy", port, baseUrl });
    } catch (error) {
      log(`  [失败] ${pid.padEnd(14)} ${error.message}`);
      results.push({ provider: pid, mode: "direct", baseUrl });
    }
  }
  return results;
}

/** 把代理结果写进 config.toml 的 provider 块 */
export function writeProxyConfig(results) {
  let config = fs.readFileSync(CONFIG_PATH, "utf8");
  for (const r of results) {
    if (r.mode !== "proxy") continue;
    const re = new RegExp(`(\\[model_providers\\.${r.provider}\\][\\s\\S]*?)base_url = "[^"]*"`);
    config = config.replace(re, `$1base_url = "http://127.0.0.1:${r.port}"`);
    // 本地代理不需要真实 token，保留一个占位即可
    config = config.replace(
      new RegExp(`(\\[model_providers\\.${r.provider}\\][\\s\\S]*?)experimental_bearer_token = "[^"]*"`),
      `$1experimental_bearer_token = "local-proxy"`,
    );
  }
  fs.writeFileSync(CONFIG_PATH, config);
}

/** 恢复成直连 base_url */
export function restoreDirectConfig() {
  const models = JSON.parse(fs.readFileSync(WORKBUDDY_MODELS, "utf8"));
  let config = fs.readFileSync(CONFIG_PATH, "utf8");
  for (const m of models) {
    const pid = providerIdFor(m.url);
    if (!pid) continue;
    const baseUrl = baseUrlFor(m.url);
    config = config.replace(
      new RegExp(`(\\[model_providers\\.${pid}\\][\\s\\S]*?)base_url = "[^"]*"`),
      `$1base_url = "${baseUrl}"`,
    );
  }
  fs.writeFileSync(CONFIG_PATH, config);
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("proxy-manager.mjs")) {
  if (process.argv.includes("--stop")) {
    restoreDirectConfig();
    console.log("✅ 已恢复直连 base_url");
    process.exit(0);
  }
  if (process.argv.includes("--detect-only")) {
    // 只探测不启动，用于启动器里做判断
    console.log("正在检测各服务商 Responses 兼容性...");
    const results = await startAllProxies({ log: (m) => console.log(m) });
    console.log(JSON.stringify(results));
    process.exit(0);
  }
  console.log("正在检测各服务商 Responses 兼容性...");
  const results = await startAllProxies();
  writeProxyConfig(results);
  console.log("✅ config.toml 已更新");
  console.log("   ", results.map((r) => `${r.provider}=${r.mode}`).join(" | "));
  // 常驻：代理要一直活着
  console.log("代理常驻中，Ctrl+C 退出");
  await new Promise(() => {});
}
