import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TokenUsageCollector } from "./token-usage.mjs";

const POLL_INTERVAL_MS = 2500;

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
  const handle = await open(filePath, "r");
  let content;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    content = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
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
  const handle = await open(filePath, "r");
  let remaining;
  try {
    const { size } = await handle.stat();
    if (offset > size) offset = 0;
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    remaining = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
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

export function defaultCodexHome() {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export class CodexSessionUsageCollector {
  constructor({
    codexHome = defaultCodexHome(),
    dataDirectory,
    uploadUrl,
    uploadToken,
    logger = console,
  } = {}) {
    if (!dataDirectory) throw new Error("CodexSessionUsageCollector requires dataDirectory");
    this.codexHome = path.resolve(codexHome);
    this.dataDirectory = path.resolve(dataDirectory);
    this.statePath = path.join(this.dataDirectory, "token-usage-session-state.json");
    this.collector = new TokenUsageCollector({
      dataDirectory: this.dataDirectory,
      eventsPath: path.join(this.dataDirectory, "token-usage-session-events.jsonl"),
      statePath: path.join(this.dataDirectory, "token-usage-session-upload-state.json"),
      configPath: path.join(this.dataDirectory, "token-usage-config.json"),
      ...(uploadUrl !== undefined ? { uploadUrl } : {}),
      ...(uploadToken !== undefined ? { uploadToken } : {}),
      logger,
    });
    this.logger = logger;
    this.timer = null;
  }

  async scan() {
    const state = await loadState(this.statePath);
    let dirty = false;
    let recorded = 0;
    const directories = [
      path.join(this.codexHome, "sessions"),
      path.join(this.codexHome, "archived_sessions"),
    ];
    const files = (await Promise.all(directories.map((directory) => walkFiles(directory)))).flat();
    const activeFiles = new Set();
    for (const filePath of files) {
      const fileStat = await stat(filePath);
      activeFiles.add(filePath);
      // Track the read offset per file: a resumed session can have several
      // rollout files that share one session id, and one shared offset would
      // replay the same records over and over.
      let entry = state.files[filePath];
      if (!entry) {
        entry = {
          offset: fileStat.size,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          filePath,
          metadata: await readMetadata(filePath),
        };
        state.files[filePath] = entry;
        dirty = true;
        continue;
      }
      if (entry.size === fileStat.size && entry.mtimeMs === fileStat.mtimeMs) continue;
      const offset = Number.isInteger(entry.offset) && entry.offset >= 0 ? entry.offset : 0;
      const { lines, nextOffset } = await readNewLines(filePath, offset);
      let metadata = entry.metadata ?? {};
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
        const event = await this.collector.recordCodexSessionUsage({
          sessionId: value.payload?.session_id ?? path.basename(filePath, ".jsonl"),
          ...record,
        });
        if (event) recorded += 1;
      }
      entry.offset = nextOffset;
      entry.size = fileStat.size;
      entry.mtimeMs = fileStat.mtimeMs;
      entry.filePath = filePath;
      entry.metadata = metadata;
      dirty = true;
    }
    for (const filePath of Object.keys(state.files)) {
      if (!activeFiles.has(filePath)) {
        delete state.files[filePath];
        dirty = true;
      }
    }
    if (dirty) await saveState(this.statePath, state);
    if (recorded > 0) return this.collector.flush();
    return null;
  }

  start() {
    if (this.timer) return;
    this.collector.start();
    this.timer = setInterval(() => {
      void this.scan().catch((error) => this.logger.error?.(
        `Codex token usage scan failed: ${error.message}`,
      ));
    }, POLL_INTERVAL_MS);
    void this.scan().catch((error) => this.logger.error?.(
      `Codex token usage scan failed: ${error.message}`,
    ));
  }

  async status() {
    return this.collector.status();
  }

  async flush() {
    return this.collector.flush();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.scan();
    await this.collector.close();
  }
}
