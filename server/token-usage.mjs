import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CONFIG_VERSION = 1;
const DEFAULT_UPLOAD_URL = "https://ttokens.lusixian.com/api/token-usage/events";
const FLUSH_INTERVAL_MS = 15_000;
const MAX_BATCH_SIZE = 100;

function finiteToken(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function firstToken(...values) {
  for (const value of values) {
    const token = finiteToken(value);
    if (token !== null) return token;
  }
  return 0;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = firstToken(usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens);
  const cachedInputTokens = firstToken(
    usage.cachedInputTokens,
    usage.cached_input_tokens,
    usage.cacheReadInputTokens,
    usage.cache_read_input_tokens,
    usage.promptTokensDetails?.cachedTokens,
  );
  const outputTokens = firstToken(
    usage.outputTokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.completion_tokens,
  );
  const reasoningOutputTokens = firstToken(
    usage.reasoningOutputTokens,
    usage.reasoning_output_tokens,
    usage.completionTokensDetails?.reasoningTokens,
  );
  const suppliedTotal = finiteToken(
    usage.totalTokens
      ?? usage.total_tokens
      ?? usage.totalTokenCount,
  );
  const totalTokens = suppliedTotal ?? inputTokens + outputTokens;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function subtractUsage(current, previous) {
  const delta = {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      current.reasoningOutputTokens - previous.reasoningOutputTokens,
    ),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
  return delta.totalTokens > 0 || delta.inputTokens > 0 || delta.outputTokens > 0
    ? delta
    : null;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function normalizeConfig(value, defaults) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const uploadUrl = typeof source.uploadUrl === "string" && source.uploadUrl.trim()
    ? source.uploadUrl.trim()
    : defaults.uploadUrl;
  return {
    version: CONFIG_VERSION,
    enabled: source.enabled !== false,
    uploadUrl,
    uploadToken: typeof source.uploadToken === "string" ? source.uploadToken : defaults.uploadToken,
  };
}

function normalizeState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    journalOffset: Number.isInteger(source.journalOffset) && source.journalOffset >= 0
      ? source.journalOffset
      : 0,
    threadTotals: source.threadTotals && typeof source.threadTotals === "object"
      ? source.threadTotals
      : {},
    lastUploadAt: typeof source.lastUploadAt === "string" ? source.lastUploadAt : null,
    lastUploadError: typeof source.lastUploadError === "string" ? source.lastUploadError : null,
    uploadedEvents: Number.isInteger(source.uploadedEvents) && source.uploadedEvents >= 0
      ? source.uploadedEvents
      : 0,
  };
}

export class TokenUsageCollector {
  constructor({
    dataDirectory,
    eventsPath = path.join(dataDirectory, "token-usage-events.jsonl"),
    statePath = path.join(dataDirectory, "token-usage-state.json"),
    configPath = path.join(dataDirectory, "token-usage-config.json"),
    uploadUrl = process.env.CODEX_TOKEN_RANKING_UPLOAD_URL ?? DEFAULT_UPLOAD_URL,
    uploadToken = process.env.CODEX_TOKEN_RANKING_UPLOAD_TOKEN ?? "",
    fetchImplementation = globalThis.fetch,
    logger = console,
  } = {}) {
    if (!dataDirectory) throw new Error("TokenUsageCollector requires dataDirectory");
    this.dataDirectory = dataDirectory;
    this.eventsPath = eventsPath;
    this.statePath = statePath;
    this.configPath = configPath;
    this.defaults = { uploadUrl, uploadToken };
    this.fetch = fetchImplementation;
    this.logger = logger;
    this.writeQueue = Promise.resolve();
    this.flushTimer = null;
    this.config = null;
    this.state = null;
  }

  start() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
    void this.flush();
  }

  async close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flush();
  }

  async status() {
    return this.#enqueue(async () => {
      const config = await this.#readConfig();
      const state = await this.#readState();
      return {
        enabled: config.enabled,
        uploadUrl: config.uploadUrl,
        hasUploadToken: Boolean(config.uploadToken),
        queuedEvents: await this.#queuedEventCount(state),
        lastUploadAt: state.lastUploadAt,
        lastUploadError: state.lastUploadError,
      };
    });
  }

  async updateSettings({ enabled, uploadUrl, uploadToken } = {}) {
    return this.#enqueue(async () => {
      const current = await this.#readConfig();
      const next = normalizeConfig({
        ...current,
        ...(enabled === undefined ? {} : { enabled }),
        ...(uploadUrl === undefined ? {} : { uploadUrl }),
        ...(uploadToken === undefined ? {} : { uploadToken }),
      }, this.defaults);
      await this.#writeJson(this.configPath, next);
      this.config = next;
      return {
        enabled: next.enabled,
        uploadUrl: next.uploadUrl,
        hasUploadToken: Boolean(next.uploadToken),
      };
    });
  }

  async recordRelayUsage({
    provider,
    model,
    usage,
    sourceEventId,
    hostId,
  } = {}) {
    const normalized = normalizeUsage(usage);
    if (!normalized) return null;
    return this.#enqueue(async () => {
      const config = await this.#readConfig();
      if (!config.enabled) return null;
      const eventId = typeof sourceEventId === "string" && sourceEventId.trim()
        ? `relay:${sourceEventId.trim()}`
        : `relay:${randomUUID()}`;
      const event = this.#event({
        eventId,
        source: "relay-response",
        provider,
        model,
        hostId,
        usage: normalized,
      });
      await this.#appendEvent(event);
      return event;
    });
  }

  async recordThreadUsage({
    threadId,
    turnId,
    provider = "codex",
    model,
    hostId,
    lastUsage,
    totalUsage,
  } = {}) {
    if (typeof threadId !== "string" || !threadId) return null;
    const current = normalizeUsage(totalUsage);
    const last = normalizeUsage(lastUsage);
    if (!current && !last) return null;
    return this.#enqueue(async () => {
      const config = await this.#readConfig();
      if (!config.enabled) return null;
      const state = await this.#readState();
      const cursor = `${hostId ?? "local"}\0${threadId}`;
      const eventCursor = cursor.replaceAll("\0", ":");
      const previous = normalizeUsage(state.threadTotals[cursor]) ?? emptyUsage();
      const usage = current ? subtractUsage(current, previous) : last;
      if (!usage) return null;
      const event = this.#event({
        eventId: `codex:${eventCursor}:${turnId ?? "unknown"}:${current?.totalTokens ?? usage.totalTokens}`,
        source: "codex-app-server",
        provider,
        model,
        hostId,
        threadId,
        turnId,
        usage,
      });
      await this.#appendEvent(event);
      if (current) state.threadTotals[cursor] = current;
      await this.#writeJson(this.statePath, state);
      this.state = state;
      return event;
    });
  }

  async flush() {
    return this.#enqueue(async () => {
      const config = await this.#readConfig();
      const state = await this.#readState();
      if (
        !config.enabled
        || !config.uploadUrl
        || !config.uploadToken
        || typeof this.fetch !== "function"
      ) {
        return { uploaded: 0, queued: await this.#queuedEventCount(state) };
      }
      let buffer;
      try {
        buffer = await readFile(this.eventsPath);
      } catch (error) {
        if (error.code === "ENOENT") return { uploaded: 0, queued: 0 };
        throw error;
      }
      if (state.journalOffset > buffer.length) state.journalOffset = 0;
      const remaining = buffer.subarray(state.journalOffset);
      const newline = remaining.lastIndexOf(0x0a);
      if (newline < 0) return { uploaded: 0, queued: await this.#queuedEventCount(state) };
      const lines = remaining.subarray(0, newline).toString("utf8").split("\n").filter(Boolean);
      if (lines.length === 0) return { uploaded: 0, queued: await this.#queuedEventCount(state) };
      const events = [];
      for (const line of lines.slice(0, MAX_BATCH_SIZE)) {
        try {
          const value = JSON.parse(line);
          if (value && typeof value === "object") events.push(value);
        } catch {
          // Ignore a malformed line and advance past it with the next upload.
        }
      }
      const consumedBytes = Buffer.byteLength(
        `${lines.slice(0, MAX_BATCH_SIZE).join("\n")}\n`,
        "utf8",
      );
      try {
        const headers = { "content-type": "application/json" };
        if (config.uploadToken) headers.authorization = `Bearer ${config.uploadToken}`;
        const response = await this.fetch(config.uploadUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ events }),
        });
        if (!response.ok) throw new Error(`upload returned HTTP ${response.status}`);
        state.journalOffset += consumedBytes;
        state.lastUploadAt = new Date().toISOString();
        state.lastUploadError = null;
        state.uploadedEvents += events.length;
        await this.#writeJson(this.statePath, state);
        this.state = state;
        return { uploaded: events.length, queued: await this.#queuedEventCount(state) };
      } catch (error) {
        state.lastUploadError = error instanceof Error ? error.message : String(error);
        await this.#writeJson(this.statePath, state);
        this.state = state;
        this.logger.warn?.(`Token usage upload deferred: ${state.lastUploadError}`);
        return { uploaded: 0, queued: await this.#queuedEventCount(state) };
      }
    });
  }

  #event({ eventId, source, provider, model, hostId, threadId, turnId, usage }) {
    return {
      eventId,
      source,
      provider: typeof provider === "string" && provider ? provider : "unknown",
      model: typeof model === "string" && model ? model : "unknown",
      ...(hostId ? { hostId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...usage,
      estimated: false,
      occurredAt: new Date().toISOString(),
    };
  }

  async #appendEvent(event) {
    await mkdir(path.dirname(this.eventsPath), { recursive: true });
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async #readConfig() {
    try {
      this.config = normalizeConfig(JSON.parse(await readFile(this.configPath, "utf8")), this.defaults);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.config = normalizeConfig({}, this.defaults);
      await this.#writeJson(this.configPath, this.config);
    }
    return this.config;
  }

  async #readState() {
    if (this.state) return this.state;
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = normalizeState({});
    }
    return this.state;
  }

  async #writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  }

  async #queuedEventCount(state) {
    try {
      const buffer = await readFile(this.eventsPath);
      return buffer.subarray(state.journalOffset).toString("utf8").split("\n").filter(Boolean).length;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }

  #enqueue(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}

export { DEFAULT_UPLOAD_URL, normalizeUsage };
