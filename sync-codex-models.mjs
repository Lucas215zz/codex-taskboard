// 从 WorkBuddy 的 models.json 生成 Codex 自定义模型目录 + 多 provider 配置
//
// 背景：
//   Codex 只支持 wire_api = "responses"，因此跨服务商模型必须提供 Responses 兼容端点。
//   实测（2026-10-21）：
//     - https://api.minimaxi.com/v1/responses      -> 200 ✅（支持 Responses）
//     - https://ai-api.kkidc.com/v1/responses      -> 500 not implemented ❌（仅 chat）
//     - https://open.bigmodel.cn/api/paas/v4/...   -> 404 ❌（仅 chat）
//     - https://agentaipilot.com/v1/responses      -> 502/429（路由正确，限流）
//   实测（2026-10-22）：
//     - https://api.deepseek.com/responses         -> 200 ✅（支持 Responses，可直连）
//     - reasoning.effort = low/medium/high/xhigh/max -> 全部 200 ✅
//   所以 claude-opus-4-7 / glm-5.3-flashx 只能作为"目录可见 + 走中转站"的项，
//   若中转站不转发这些模型则请求会失败——脚本会把这类模型标记出来。
//
// 用法：
//   node sync-codex-models.mjs            生成目录 + 更新 config.toml
//   node sync-codex-models.mjs --check    只检查不写

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// 项目根目录
//
// 注意：这里必须用 fileURLToPath(import.meta.url)，
// 不能用 new URL(import.meta.url).pathname ——
// 后者返回的是百分号编码的路径，项目目录一旦含中文
// （如 E:\github\codex-任务面板插件\...）就会得到
// %E4%BB%BB%E5%8A%A1... 这种乱码路径，写文件直接 ENOENT。
//
// 当前项目路径：E:\github\dashi-taskboard-main（纯英文，最省心）
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const WORKBUDDY_MODELS = path.join(os.homedir(), ".workbuddy", "models.json");
const CODEX_HOME = path.join(os.homedir(), ".codex");
const CATALOG_PATH = path.join(CODEX_HOME, "model-catalog.json");
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const CHECK_ONLY = process.argv.includes("--check");

// ---------------------------------------------------------------- 官方模型
// Codex 内置的官方模型清单（来自 app-server model/list，2026-10-21 实测）
const OFFICIAL_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", supportsReasoning: true, supportsImages: true, vendor: "OpenAI" },
  { id: "gpt-6-astra", name: "GPT-6-Astra", supportsReasoning: true, supportsImages: true, vendor: "OpenAI" },
  { id: "gpt-6-sol", name: "GPT-6-Sol", supportsReasoning: true, supportsImages: true, vendor: "OpenAI" },
  { id: "gpt-6-luna", name: "GPT-6-Luna", supportsReasoning: true, supportsImages: true, vendor: "OpenAI" },
  { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", supportsReasoning: true, supportsImages: true, vendor: "OpenAI" },
  { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", supportsReasoning: true, supportsImages: true, vendor: "OpenAI" },
  { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", supportsReasoning: true, supportsImages: true, vendor: "OpenAI" },
  { id: "gpt-5.5", name: "GPT-5.5", supportsReasoning: true, supportsImages: true, vendor: "OpenAI" },
];

// ---------------------------------------------------------------- 模型目录模板
// 字段类型已通过 app-server 实测验证（2026-10-21）：
//   comp_hash 必须是字符串；其余数值字段必须是数字；
//   truncation_policy = { limit: <i64>, mode: "tokens" | "bytes" }
function catalogEntry(m, priority) {
  const efforts = effortsFor(m);
  return {
    slug: m.id,
    display_name: m.name,
    default_reasoning_level: defaultEffortFor(m, efforts),
    supported_reasoning_levels: efforts.map((e) => ({ effort: e, description: describeEffort(e) })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    available_access_programs: null,
    availability_nux: null,
    upgrade: null,
    model_messages: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    // 新版 Codex (0.122.0) 必填字段，缺失会导致 model_catalog_json 解析失败
    // （missing field `supports_reasoning_summaries`），表现为所有模型都连不上
    supports_reasoning_summaries: true,
    supports_parallel_tool_calls: true,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: m.supportsImages ? "text_and_image" : "text",
    truncation_policy: { limit: 128000, mode: "tokens" },
    supports_image_detail_original: false,
    context_window: 200000,
    max_context_window: 200000,
    auto_compact_token_limit: 180000,
    comp_hash: "0",
    effective_context_window_percent: 100,
    experimental_supported_tools: [],
    input_modalities: m.supportsImages ? ["text", "image"] : ["text"],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: null,
    multi_agent_version: null,
    multi_agent_reasoning_effort: null,
    base_instructions: "You are a helpful assistant.",
  };
}

function describeEffort(e) {
  return {
    minimal: "最省 token，适合简单任务",
    low: "快速响应，更轻量推理",
    medium: "速度与推理深度平衡",
    high: "更高推理深度，适合复杂问题",
    xhigh: "极高推理深度，适合最难问题",
    max: "厂商最高档推理深度",
  }[e] || e;
}

// WorkBuddy models.json 里模型可以自带 reasoning 声明（defaultEffort / supportedEfforts），
// 照搬到目录里，避免 Codex 菜单显示的档位和厂商实际支持的对不上。
// 例：deepseek-flash 声明 supportedEfforts = ["high","max"]、defaultEffort = "high"。
//
// 白名单 KNOWN_EFFORTS 必须与当前 Codex 版本的 effort 枚举完全一致，
// 不在白名单里的档位直接丢弃，避免整个目录解析失败导致所有模型消失。
// ⚠️ 2026-10-23 更新：codex 0.122.0 实测只接受 none/minimal/low/medium/high/xhigh，
//    旧版的 "max"/"ultra" 已不被识别（报 unknown variant `max`），必须移除。
const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

function effortsFor(m) {
  const base = m.supportsReasoning
    ? ["low", "medium", "high", "xhigh"]
    : ["low", "medium", "high"];
  if (!m.supportsReasoning) return base;
  const extra = (m.reasoning?.supportedEfforts || []).filter(
    (e) => KNOWN_EFFORTS.includes(e) && !base.includes(e),
  );
  return [...base, ...extra];
}

function defaultEffortFor(m, efforts) {
  const want = m.reasoning?.defaultEffort;
  return want && efforts.includes(want) ? want : "medium";
}

// ---------------------------------------------------------------- provider 映射
// 每个 WorkBuddy 模型归到一个 Codex model_provider。
// Codex 的 provider id 必须是合法的 TOML 键，这里用可读名字。
function providerIdFor(m) {
  const url = m.url;
  if (url.includes("agentaipilot.com")) return "agentaipilot";
  if (url.includes("kkidc.com")) return "kkidc";
  if (url.includes("bigmodel.cn")) return "zhipu";
  if (url.includes("minimaxi.com")) return "minimax";
  if (url.includes("api.deepseek.com")) return "deepseek";
  return "custom_" + hash(m.url);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 8);
}

// base_url 必须严格按 WorkBuddy models.json 的 url 推导：
//   只去掉末尾的 /chat/completions（那是 WorkBuddy 用的完整 chat 端点），
//   必须保留 /v1 —— Codex 的 wire_api="responses" 会在 base_url 后拼 /responses，
//   如果把 /v1 剥掉，https://agentaipilot.com/v1 会变成 https://agentaipilot.com
//   请求就会打到 https://agentaipilot.com/responses（404 / 串到别的服务商）。
//
//   映射关系（实测 2026-10-21）：
//   https://ai-api.kkidc.com/v1              -> https://ai-api.kkidc.com/v1
//   https://agentaipilot.com/v1               -> https://agentaipilot.com/v1
//   https://open.bigmodel.cn/api/paas/v4      -> https://open.bigmodel.cn/api/paas/v4
//   https://api.minimaxi.com/v1/chat/completions -> https://api.minimaxi.com/v1
//   https://api.deepseek.com/chat/completions -> https://api.deepseek.com
function baseUrlFor(m) {
  return m.url.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
}

function providerBlock(id, m) {
  return [
    `[model_providers.${id}]`,
    `name = "${m.vendor || id}"`,
    `base_url = "${baseUrlFor(m)}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `experimental_bearer_token = "${m.apiKey}"`,
    `supports_websockets = false`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- 主流程
const raw = fs.readFileSync(WORKBUDDY_MODELS, "utf8");
const models = JSON.parse(raw);
if (!Array.isArray(models) || !models.length) {
  console.error("models.json 解析失败或为空");
  process.exit(1);
}

// 目录条目 = 官方模型 + WorkBuddy 自定义模型
// 注意：设置 model_catalog_json 后，Codex 不再回落到服务端官方目录，
//       所以必须把官方模型也写进来，否则 gpt-6.x 系列会消失。
const officialIds = new Set(OFFICIAL_MODELS.map((o) => o.id));
// slugOf：记录每个 WorkBuddy 模型在目录中的最终 slug（重名会加 -wb）
const slugOf = new Map();
const entries = [
  ...OFFICIAL_MODELS.map((o, i) => catalogEntry(o, i + 1)),
  ...models.map((m, i) => {
    // 与官方模型重名时加 -wb 后缀，避免 slug 冲突
    const e = catalogEntry(m, OFFICIAL_MODELS.length + i + 1);
    if (officialIds.has(e.slug)) {
      e.slug = e.slug + "-wb";
    }
    // 统一加 (WB) 标识：菜单里一眼能分辨官方模型与 WorkBuddy 自定义模型
    e.display_name = e.display_name.replace(/\s*\(WB\)$/, "") + " (WB)";
    slugOf.set(m, e.slug);
    return e;
  }),
];
const catalog = { models: entries };

if (CHECK_ONLY) {
  console.log("将生成目录条目:", entries.map((e) => e.slug).join(", "));
  console.log("将写入:", CATALOG_PATH);
  console.log("将更新:", CONFIG_PATH);
  process.exit(0);
}

fs.mkdirSync(CODEX_HOME, { recursive: true });
fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
console.log("✅ 已写入模型目录:", CATALOG_PATH);
console.log("   条目:", entries.map((e) => e.slug).join(", "));

// ---- 更新 config.toml：追加 providers + model_catalog_json（幂等）
let config = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : "";

// 移除旧的本工具生成的块
config = config.replace(/\n?# >>> codex-model-switcher >>>[\s\S]*?# <<< codex-model-switcher <<<\n?/g, "\n");

const providerIds = [...new Set(models.map(providerIdFor))];
const providerModel = {};
for (const m of models) {
  const pid = providerIdFor(m);
  (providerModel[pid] ||= []).push(m);
}

const block = [
  "# >>> codex-model-switcher >>>",
  "# 由 sync-codex-models.mjs 自动生成，请勿手改（改动会被覆盖）",
  `model_catalog_json = "${CATALOG_PATH.replace(/\\/g, "\\\\")}"`,
  "",
  ...providerIds.flatMap((pid) => providerBlock(pid, providerModel[pid][0])),
  "# <<< codex-model-switcher <<<",
].join("\n");

// 插到 [model_providers] 之前
const anchor = config.indexOf("\n[model_providers");
if (anchor >= 0) {
  config = config.slice(0, anchor) + "\n" + block + config.slice(anchor);
} else {
  config = config.trimEnd() + "\n\n" + block + "\n";
}

fs.writeFileSync(CONFIG_PATH, config);
console.log("✅ 已更新配置:", CONFIG_PATH);
console.log("   providers:", providerIds.join(", "));

// ---- 输出模型->provider 映射，供切换器使用
// 注意：id 必须是目录里的最终 slug（重名模型带 -wb 后缀），否则切换器匹配不到
//
// 官方模型也必须进映射：切回官方模型时 provider 要写回 codex_local_access，
// 否则会残留上一个自定义模型的 provider（比如切回 gpt-6.1-sol 但 provider 还是 kkidc）。
const map = [
  ...OFFICIAL_MODELS.map((o) => ({
    id: o.id,
    sourceId: o.id,
    provider: "codex_local_access",
    baseUrl: "",
  })),
  ...models.map((m) => ({
    id: slugOf.get(m) || m.id,
    sourceId: m.id,
    provider: providerIdFor(m),
    baseUrl: baseUrlFor(m),
  })),
];
fs.writeFileSync(
  path.join(PROJECT_ROOT, "model-provider-map.json"),
  JSON.stringify(map, null, 2),
);
console.log("✅ 已导出映射: model-provider-map.json");
console.log("   ", map.map((m) => `${m.id} -> ${m.provider}`).join(" | "));

// ---- 自检 + 自愈：model 与 model_provider 必须自洽
//
// Codex 把 config.toml 里的 model 和 model_provider 当成一个「组合」使用：
// 请求会带着 model 的值发到 model_provider 指向的服务商。
// 两者错配时报错来自服务商，而不是 Codex，例如：
//   model = "MiniMax-M3.1-Flash" + model_provider = "zhipu"
//   -> 智谱返回 {"code":"1211","message":"模型不存在，请检查模型代码。"}
// 错配最常见的成因是「点了原生模型菜单」：原生菜单只写 model，
// 而补写 provider 的逻辑是异步的，中间态就会留下错配。
//
// 所以每次同步后都对一次，不一致直接纠正。
{
  const providerById = Object.fromEntries(map.map((m) => [m.id, m.provider]));
  let cfg = fs.readFileSync(CONFIG_PATH, "utf8");
  const curModel = (cfg.match(/^model\s*=\s*"([^"]+)"/m) || [])[1];
  const curProvider = (cfg.match(/^model_provider\s*=\s*"([^"]+)"/m) || [])[1];
  const expected = curModel ? providerById[curModel] : null;

  // ---- 本地路由器例外（2026-10-23 加）----
  //
  // 老板的体系是「所有模型统一走本地路由器，由路由器按模型名分流」，
  // 对应 model_provider = "custom" + [model_providers.custom] base_url = 127.0.0.1:8788。
  // 这种架构下 model 与 provider 本来就是「多对一」，上面的「自愈」逻辑会
  // 错误地把 custom 改写成某个直连 provider（如 minimax），反而绕开路由器。
  // 因此：只要检测到 custom 指向本地路由器，就跳过 provider 改写。
  const localRouterActive =
    /^\s*model_provider\s*=\s*"custom"/m.test(cfg) &&
    /\[model_providers\.custom\][\s\S]{0,400}?127\.0\.0\.1:8788/.test(cfg);

  if (localRouterActive) {
    console.log(`✅ 本地路由器模式生效，保持 model_provider = "custom"（模型由路由器按名分流）`);
    console.log(`   当前模型: ${curModel}`);
  } else if (curModel && expected && curProvider !== expected) {
    cfg = cfg.replace(/^model_provider\s*=.*$/m, `model_provider = "${expected}"`);
    fs.writeFileSync(CONFIG_PATH, cfg);
    console.log(`⚠️  检测到配置错配并已修正: model=${curModel} provider=${curProvider} -> ${expected}`);
  } else if (curModel && !expected) {
    console.log(`⚠️  当前模型 ${curModel} 不在映射表中，请检查模型代码`);
  } else {
    console.log(`✅ 配置自洽: model=${curModel} provider=${curProvider}`);
  }
}
