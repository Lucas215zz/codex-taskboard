import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { TokenUsageCollector } from "../server/token-usage.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_UPLOAD_URL = "https://ttokens.lusixian.com/api/token-usage/events";
const POLL_INTERVAL_MS = 2500;
const STARTUP_TASK_NAME = "Codex Token Usage Collector";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultDataDirectory() {
  return process.env.CODEX_TASKBOARD_DATA_DIR
    ?? process.env.CODEX_TOKEN_RANKING_DATA_DIR
    ?? (process.platform === "win32" && process.env.APPDATA
      ? path.join(process.env.APPDATA, "Codex Taskboard")
      : path.join(PROJECT_ROOT, ".data"));
}

function defaultCodexHome() {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function finiteToken(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function sessionMetadataLine(value, metadata) {
  const payload = value?.payload;
  if (!payload || typeof payload !== "object") return metadata;
  if (value.type === "session_meta") {
    return {
      ...metadata,
      sessionId: typeof payload.session_id === "string" && payload.session_id
        ? payload.session_id
        : typeof payload.id === "string" && payload.id
          ? payload.id
          : metadata.sessionId,
      provider: typeof payload.model_provider === "string" && payload.model_provider
        ? payload.model_provider
        : metadata.provider,
    };
  }
  if (value.type === "event_msg" && payload.type === "thread_settings_applied") {
    const settings = payload.thread_settings;
    if (!settings || typeof settings !== "object") return metadata;
    return {
      ...metadata,
      provider: typeof settings.model_provider_id === "string" && settings.model_provider_id
        ? settings.model_provider_id
        : metadata.provider,
      model: typeof settings.model === "string" && settings.model
        ? settings.model
        : metadata.model,
    };
  }
  return metadata;
}

function parseUsageRecord(value, metadata) {
  if (value?.type !== "token_usage_record") return null;
  const payload = value.payload;
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") return null;
  const responseId = typeof payload.response_id === "string" && payload.response_id
    ? payload.response_id
    : `ordinal-${payload.ordinal ?? "unknown"}`;
  return {
    responseId,
    threadId: typeof payload.thread_id === "string" ? payload.thread_id : undefined,
    turnId: typeof payload.turn_id === "string" ? payload.turn_id : undefined,
    provider: metadata.provider ?? "codex",
    model: metadata.model ?? "unknown",
    usage: {
      input_tokens: finiteToken(usage.input_tokens),
      cached_input_tokens: finiteToken(usage.cached_input_tokens),
      output_tokens: finiteToken(usage.output_tokens),
      reasoning_output_tokens: finiteToken(usage.reasoning_output_tokens),
      total_tokens: finiteToken(usage.total_tokens)
        || finiteToken(usage.input_tokens) + finiteToken(usage.output_tokens),
    },
    occurredAt: typeof value.timestamp === "string" ? value.timestamp : undefined,
  };
}

async function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walkFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      result.push(entryPath);
    }
  }
  return result;
}

async function readMetadata(filePath) {
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n").slice(0, 80);
  let metadata = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      metadata = sessionMetadataLine(JSON.parse(line), metadata);
    } catch {
      // Ignore an incomplete or malformed historical line.
    }
  }
  return metadata;
}

async function readNewLines(filePath, offset) {
  const content = await readFile(filePath);
  if (offset > content.length) offset = 0;
  const remaining = content.subarray(offset);
  const newline = remaining.lastIndexOf(0x0a);
  if (newline < 0) return { lines: [], nextOffset: offset };
  return {
    lines: remaining.subarray(0, newline).toString("utf8").split("\n").filter(Boolean),
    nextOffset: offset + newline + 1,
  };
}

function normalizeState(value) {
  return {
    files: value?.files && typeof value.files === "object" ? value.files : {},
  };
}

async function loadState(statePath) {
  try {
    return normalizeState(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return normalizeState({});
    throw error;
  }
}

async function saveState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export class CodexSessionUsageCollector {
  constructor({
    codexHome = defaultCodexHome(),
    dataDirectory = defaultDataDirectory(),
    uploadUrl = process.env.CODEX_TOKEN_RANKING_UPLOAD_URL ?? DEFAULT_UPLOAD_URL,
    uploadToken = process.env.CODEX_TOKEN_RANKING_UPLOAD_TOKEN ?? "",
    logger = console,
  } = {}) {
    this.codexHome = path.resolve(codexHome);
    this.dataDirectory = path.resolve(dataDirectory);
    this.statePath = path.join(this.dataDirectory, "token-usage-session-state.json");
    this.collector = new TokenUsageCollector({
      dataDirectory: this.dataDirectory,
      eventsPath: path.join(this.dataDirectory, "token-usage-session-events.jsonl"),
      statePath: path.join(this.dataDirectory, "token-usage-session-upload-state.json"),
      configPath: path.join(this.dataDirectory, "token-usage-config.json"),
      uploadUrl,
      uploadToken,
      logger,
    });
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  async scan() {
    const state = await loadState(this.statePath);
    const directories = [
      path.join(this.codexHome, "sessions"),
      path.join(this.codexHome, "archived_sessions"),
    ];
    const files = (await Promise.all(directories.map((directory) => walkFiles(directory)))).flat();
    const activeFiles = new Set();
    for (const filePath of files) {
      const fileStat = await stat(filePath);
      const fileMetadata = await readMetadata(filePath);
      activeFiles.add(filePath);
      // Track the read offset per file: a resumed session can have several
      // rollout files that share one session id, and one shared offset would
      // replay the same records over and over.
      let entry = state.files[filePath];
      if (!entry) {
        entry = {
          offset: fileStat.size,
          filePath,
          metadata: fileMetadata,
        };
        state.files[filePath] = entry;
        continue;
      }
      const offset = Number.isInteger(entry.offset) && entry.offset >= 0 ? entry.offset : 0;
      const { lines, nextOffset } = await readNewLines(filePath, offset);
      let metadata = fileMetadata;
      for (const line of lines) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        metadata = sessionMetadataLine(value, metadata);
        const record = parseUsageRecord(value, metadata);
        if (!record) continue;
        await this.collector.recordCodexSessionUsage({
          sessionId: value.payload?.session_id ?? path.basename(filePath, ".jsonl"),
          ...record,
        });
      }
      entry.offset = nextOffset;
      entry.filePath = filePath;
      entry.metadata = metadata;
    }
    for (const filePath of Object.keys(state.files)) {
      if (!activeFiles.has(filePath)) delete state.files[filePath];
    }
    await saveState(this.statePath, state);
    return this.collector.flush();
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.collector.start();
    this.timer = setInterval(() => {
      void this.scan().catch((error) => this.logger.error?.(
        `Codex token usage scan failed: ${error.message}`,
      ));
    }, POLL_INTERVAL_MS);
    void this.scan();
  }

  async close() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.scan();
    await this.collector.close();
  }
}

function installStartupTask({ scriptPath, dataDirectory, codexHome }) {
  if (process.platform !== "win32") {
    throw new Error("Windows startup task installation is only supported on Windows");
  }
  const taskCommand = `"${process.execPath}" "${scriptPath}" --data-dir "${dataDirectory}" --codex-home "${codexHome}"`;
  const result = spawnSync("schtasks.exe", [
    "/Create",
    "/TN",
    STARTUP_TASK_NAME,
    "/SC",
    "ONLOGON",
    "/TR",
    taskCommand,
    "/RL",
    "LIMITED",
    "/F",
  ], { encoding: "utf8" });
  if (result.status === 0) return "task-scheduler";
  const startupCommand = `"${process.execPath}" "${scriptPath}" --data-dir "${dataDirectory}" --codex-home "${codexHome}"`;
  const fallback = spawnSync("reg.exe", [
    "ADD",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/V",
    STARTUP_TASK_NAME,
    "/T",
    "REG_SZ",
    "/D",
    startupCommand,
    "/F",
  ], { encoding: "utf8" });
  if (fallback.status !== 0) {
    throw new Error(
      fallback.stderr?.trim()
      || fallback.stdout?.trim()
      || result.stderr?.trim()
      || result.stdout?.trim()
      || "无法创建 Windows 启动项",
    );
  }
  return "registry";
}

function uninstallStartupTask() {
  if (process.platform !== "win32") {
    throw new Error("Windows startup task removal is only supported on Windows");
  }
  spawnSync("schtasks.exe", [
    "/Delete",
    "/TN",
    STARTUP_TASK_NAME,
    "/F",
  ], { encoding: "utf8" });
  const result = spawnSync("reg.exe", [
    "DELETE",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/V",
    STARTUP_TASK_NAME,
    "/F",
  ], { encoding: "utf8" });
  if (result.status !== 0 && !/value does not exist|找不到/i.test(result.stdout ?? "")) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "无法删除 Windows 启动项");
  }
}

const dataDirectory = path.resolve(argumentValue("--data-dir") ?? defaultDataDirectory());
const codexHome = path.resolve(argumentValue("--codex-home") ?? defaultCodexHome());
const scriptPath = path.resolve(fileURLToPath(import.meta.url));

if (process.argv.includes("--install-startup")) {
  const mode = installStartupTask({ scriptPath, dataDirectory, codexHome });
  console.log(`Installed ${STARTUP_TASK_NAME} via ${mode}`);
} else if (process.argv.includes("--uninstall-startup")) {
  uninstallStartupTask();
  console.log(`Removed ${STARTUP_TASK_NAME}`);
} else if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const collector = new CodexSessionUsageCollector({ codexHome, dataDirectory });
  const shutdown = async () => {
    await collector.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (process.argv.includes("--once")) {
    await collector.scan();
  } else {
    collector.start();
    console.log(`Codex token usage collector watching ${codexHome}`);
    await new Promise(() => {});
  }
}
