import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(root, "public");
const dataDirectory = process.env.TOKEN_RANKING_DATA_DIR ?? path.join(root, "data");
const dataPath = path.join(dataDirectory, "database.json");
const host = process.env.TOKEN_RANKING_HOST ?? "127.0.0.1";
const port = Number(process.env.TOKEN_RANKING_PORT ?? 3090);
const maxBodyBytes = 2 * 1024 * 1024;
// One account can be connected from several machines. Every login/connect issues
// a new token, so keep a generous history instead of evicting older machines.
const MAX_TOKENS_PER_USER = 200;

let database = null;
let writeQueue = Promise.resolve();

function now() {
  return new Date().toISOString();
}

function emptyDatabase() {
  return { version: 1, users: [], events: {}, totals: {} };
}

async function loadDatabase() {
  try {
    const value = JSON.parse(await readFile(dataPath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDatabase();
    return {
      version: 1,
      users: Array.isArray(value.users) ? value.users : [],
      events: value.events && typeof value.events === "object" ? value.events : {},
      totals: value.totals && typeof value.totals === "object" ? value.totals : {},
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyDatabase();
    throw error;
  }
}

function persistDatabase() {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${dataPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, dataPath);
  });
  return writeQueue;
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function html(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(303, { location, "cache-control": "no-store" });
  response.end();
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeDisplayName(value, fallback) {
  const displayName = typeof value === "string" ? value.trim() : "";
  return (displayName || fallback).slice(0, 80);
}

function validateCredentials(body) {
  const username = normalizeUsername(body?.username);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error("用户名需要是 3-32 位字母、数字、点、下划线或短横线");
  }
  if (password.length < 8 || password.length > 256) {
    throw new Error("密码需要是 8-256 位");
  }
  return { username, password };
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: scryptSync(password, salt, 64).toString("hex"),
  };
}

function passwordMatches(password, user) {
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(scryptSync(password, user.passwordSalt, 64).toString("hex"), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function issueToken(user) {
  const token = randomBytes(32).toString("base64url");
  user.tokens = Array.isArray(user.tokens) ? user.tokens : [];
  user.tokens.push({ hash: tokenHash(token), createdAt: now() });
  user.tokens = user.tokens.slice(-MAX_TOKENS_PER_USER);
  return token;
}

function findUserByToken(token) {
  if (!token) return null;
  const hash = tokenHash(token);
  return database.users.find((user) => (
    Array.isArray(user.tokens) && user.tokens.some((entry) => entry.hash === hash)
  )) ?? null;
}

function bearerToken(request) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice("Bearer ".length).trim()
    : "";
}

async function readRequestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("Content-Type 必须是 application/json");
  const raw = await readRequestBody(request);
  const value = JSON.parse(raw || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return value;
}

function readForm(raw) {
  return Object.fromEntries(new URLSearchParams(raw));
}

function safeNumber(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : 0;
}

function normalizeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  if (!eventId || eventId.length > 256) return null;
  const provider = typeof value.provider === "string" && value.provider.trim()
    ? value.provider.trim().slice(0, 120)
    : "unknown";
  const model = typeof value.model === "string" && value.model.trim()
    ? value.model.trim().slice(0, 200)
    : "unknown";
  const inputTokens = safeNumber(value.inputTokens);
  const cachedInputTokens = safeNumber(value.cachedInputTokens);
  const outputTokens = safeNumber(value.outputTokens);
  const reasoningOutputTokens = safeNumber(value.reasoningOutputTokens);
  const totalTokens = safeNumber(value.totalTokens) || inputTokens + outputTokens;
  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) return null;
  return {
    eventId,
    provider,
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    occurredAt: typeof value.occurredAt === "string" ? value.occurredAt.slice(0, 40) : now(),
  };
}

function emptyTotal() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    eventCount: 0,
    byProvider: {},
    byModel: {},
  };
}

function addBucket(bucket, event) {
  bucket.inputTokens += event.inputTokens;
  bucket.cachedInputTokens += event.cachedInputTokens;
  bucket.outputTokens += event.outputTokens;
  bucket.reasoningOutputTokens += event.reasoningOutputTokens;
  bucket.totalTokens += event.totalTokens;
}

function applyEvent(user, event) {
  const userId = user.id;
  database.events[userId] = database.events[userId] ?? {};
  if (database.events[userId][event.eventId]) return false;
  database.events[userId][event.eventId] = {
    totalTokens: event.totalTokens,
    occurredAt: event.occurredAt,
  };
  const total = database.totals[userId] ?? emptyTotal();
  addBucket(total, event);
  total.eventCount += 1;
  total.byProvider[event.provider] = total.byProvider[event.provider] ?? emptyTotal();
  total.byModel[event.model] = total.byModel[event.model] ?? emptyTotal();
  addBucket(total.byProvider[event.provider], event);
  addBucket(total.byModel[event.model], event);
  database.totals[userId] = total;
  return true;
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

function rankings() {
  return database.users
    .map((user) => ({
      user: publicUser(user),
      ...(database.totals[user.id] ?? emptyTotal()),
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

function rankingPage() {
  return readFile(path.join(publicDirectory, "index.html"), "utf8");
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/rankings") {
    json(response, 200, { rankings: rankings().slice(0, 100) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/me") {
    const user = findUserByToken(bearerToken(request));
    json(response, 200, { user: user ? publicUser(user) : null });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      const body = await readJson(request);
      const { username, password } = validateCredentials(body);
      if (database.users.some((user) => user.username === username)) {
        json(response, 409, { error: "用户名已存在" });
        return;
      }
      const { salt, hash } = hashPassword(password);
      const user = {
        id: randomBytes(12).toString("hex"),
        username,
        displayName: normalizeDisplayName(body.displayName, username),
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: now(),
        tokens: [],
      };
      const token = issueToken(user);
      database.users.push(user);
      await persistDatabase();
      json(response, 201, { user: publicUser(user), token });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const body = await readJson(request);
      const { username, password } = validateCredentials(body);
      const user = database.users.find((candidate) => candidate.username === username);
      if (!user || !passwordMatches(password, user)) {
        json(response, 401, { error: "用户名或密码错误" });
        return;
      }
      const token = issueToken(user);
      await persistDatabase();
      json(response, 200, { user: publicUser(user), token });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = bearerToken(request);
    const user = findUserByToken(token);
    if (user) {
      user.tokens = user.tokens.filter((entry) => entry.hash !== tokenHash(token));
      await persistDatabase();
    }
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/token-usage/events") {
    const user = findUserByToken(bearerToken(request));
    if (!user) {
      json(response, 401, { error: "需要登录后上传 Token 用量" });
      return;
    }
    try {
      const body = await readJson(request);
      if (!Array.isArray(body.events) || body.events.length > 100) {
        throw new Error("events 必须是最多 100 条记录的数组");
      }
      let accepted = 0;
      for (const value of body.events) {
        const event = normalizeEvent(value);
        if (event && applyEvent(user, event)) accepted += 1;
      }
      await persistDatabase();
      json(response, 200, { accepted, duplicate: body.events.length - accepted });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/connect") {
    const user = findUserByToken(bearerToken(request));
    if (!user) {
      json(response, 401, { error: "需要登录" });
      return;
    }
    const body = await readJson(request);
    const callback = typeof body.callback === "string" ? body.callback : "";
    const returnUrl = typeof body.returnUrl === "string" ? body.returnUrl : "";
    if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?\//.test(callback)) {
      json(response, 400, { error: "callback 必须是本机 Taskboard 地址" });
      return;
    }
    const form = new URLSearchParams({ token: issueToken(user), returnUrl });
    html(response, 200, `
      <!doctype html><meta charset="utf-8"><title>连接 Taskboard</title>
      <p>正在连接 Taskboard...</p>
      <form id="connect" method="post" action="${escapeHtml(callback)}">
        <input type="hidden" name="token" value="${escapeHtml(form.get("token"))}">
        <input type="hidden" name="returnUrl" value="${escapeHtml(returnUrl)}">
      </form>
      <script>document.getElementById("connect").submit()</script>
    `);
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    html(response, 200, await rankingPage());
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  json(response, 404, { error: "Not found" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

database = await loadDatabase();
const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    console.error(error);
    json(response, 500, { error: "服务器内部错误" });
  });
});
server.listen(port, host, () => {
  console.log(`Token ranking server listening on http://${host}:${port}`);
});
