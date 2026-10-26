// Codex Responses <-> Chat 协议转换代理
//
// 背景：Codex 只支持 wire_api = "responses"（官方已移除 chat 支持，
// 见 https://github.com/openai/codex/discussions/7782）。
// 但 WorkBuddy 里有些服务商只提供 /chat/completions：
//   - ai-api.kkidc.com     -> /v1/responses 返回 500 not implemented
//   - open.bigmodel.cn     -> /api/paas/v4/responses 返回 404
// 这个代理把 Codex 的 Responses 请求翻译成 Chat 请求，再把 Chat 响应
// 翻译回 Responses 格式，让 Codex 无感使用。
//
// 用法：
//   node responses-chat-proxy.mjs --port 48001 --target https://ai-api.kkidc.com/v1 --key <API_KEY>
//   或作为库：startProxy({ port, target, key, model })
import http from "node:http";
import { URL } from "node:url";

// ---------------------------------------------------------------- 格式转换
function responsesInputToChatMessages(input) {
  const messages = [];
  const instructions = [];
  const items = Array.isArray(input) ? input : [input];

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    // Responses 的 input 数组元素
    if (item.role === "system" || item.role === "developer") {
      instructions.push(textOf(item.content));
      continue;
    }
    if (item.role === "user" || item.role === "assistant") {
      messages.push({ role: item.role, content: textOf(item.content) });
      continue;
    }
    // 工具调用 / 工具结果
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        }],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id,
        content: textOf(item.output),
      });
      continue;
    }
    if (item.type === "message") {
      messages.push({ role: item.role || "user", content: textOf(item.content) });
      continue;
    }
    if (item.type === "reasoning") continue;
    if (item.type === "input_text" || item.type === "output_text") {
      messages.push({ role: "user", content: item.text || "" });
    }
  }
  return { instructions: instructions.filter(Boolean), messages };
}

function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c.text || c.content || ""))
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function chatToResponses(chat, model) {
  const message = chat.choices?.[0]?.message || {};
  const content = message.content
    || (Array.isArray(message.reasoning_content) ? message.reasoning_content.join("\n") : "")
    || "";
  const output = [];

  if (message.reasoning_content) {
    output.push({
      id: "rs_" + Math.random().toString(36).slice(2, 10),
      type: "reasoning",
      status: "completed",
      summary: [],
      content: [{ type: "reasoning_text", text: String(message.reasoning_content) }],
    });
  }

  const toolCalls = message.tool_calls || [];
  for (const tc of toolCalls) {
    output.push({
      id: "fc_" + Math.random().toString(36).slice(2, 10),
      type: "function_call",
      status: "completed",
      call_id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments || "{}",
    });
  }

  if (!toolCalls.length || content) {
    output.push({
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }

  return {
    id: chat.id || "resp_" + Math.random().toString(36).slice(2, 12),
    object: "response",
    created_at: chat.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: chat.model || model,
    output,
    output_text: content,
    usage: chat.usage
      ? {
          input_tokens: chat.usage.prompt_tokens || 0,
          output_tokens: chat.usage.completion_tokens || 0,
          total_tokens: chat.usage.total_tokens || 0,
        }
      : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  };
}

// ---------------------------------------------------------------- 代理服务
export function startProxy({ port, target, key, provider, onUsage, log = () => {} }) {
  const targetUrl = new URL(target.replace(/\/+$/, "") + "/chat/completions");

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/responses")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "only POST /responses is supported" } }));
      return;
    }

    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(raw || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
        return;
      }

      const { instructions, messages } = responsesInputToChatMessages(body.input);
      const wantStream = body.stream === true;
      log(`收到请求 model=${body.model} stream=${body.stream} tools=${body.tools?.length || 0} msgs=${messages.length}`);
      const chatBody = {
        model: body.model,
        messages: [
          ...(instructions.length ? [{ role: "system", content: instructions.join("\n\n") }] : []),
          ...messages,
        ],
        stream: false,
      };
      if (body.tools?.length) {
        chatBody.tools = body.tools.map((t) => {
          // Responses 的 tool 可能是：
          //   { type:"function", name, description, parameters }        标准函数
          //   { type:"custom", name, description, format:{...} }        自定义(freeform) 工具
          //   { type:"function", function:{...} }                       已嵌套
          // 嵌套结构统一摊平
          const fn = t.function && typeof t.function === "object" ? t.function : t;
          const name = fn.name || t.name;
          const description = fn.description || t.description;
          const parameters = fn.parameters || t.parameters;
          const out = { type: "function", function: { name, description } };
          // 部分服务商（如 zhipu）要求 parameters 必填，
          // 缺失时给出通用 object schema，否则报 1210 参数错误
          out.function.parameters = parameters && typeof parameters === "object"
            ? parameters
            : { type: "object", properties: {}, additionalProperties: true };
          return out;
        }).filter((t) => t.function.name);   // 丢掉无法识别的匿名工具
        if (body.tool_choice) chatBody.tool_choice = body.tool_choice;
      }
      if (body.temperature != null) chatBody.temperature = body.temperature;
      if (body.top_p != null) chatBody.top_p = body.top_p;
      if (body.max_output_tokens != null) chatBody.max_tokens = body.max_output_tokens;

      // 调试：打印转发的 chat 请求体（DEBUG_PROXY=1 开启）
      if (process.env.DEBUG_PROXY) {
        const slim = {};
        for (const [k, v] of Object.entries(chatBody)) {
          if (k === "messages") slim[k] = `[${v.length} 条]`;
          else if (k === "tools") slim[k] = `[${v.length} 个]`;
          else slim[k] = v;
        }
        log(`[debug] 上游字段: ${JSON.stringify(slim)}`);
      }
      // 调试：把完整请求体落盘，用于离线复现（DEBUG_PROXY_DUMP=目录）
      if (process.env.DEBUG_PROXY_DUMP) {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const dir = process.env.DEBUG_PROXY_DUMP;
        fs.mkdirSync(dir, { recursive: true });
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // 原始 Responses 请求体（Codex 实际发的，用于复现问题）
        fs.writeFileSync(
          path.join(dir, `raw-${stamp}.json`),
          JSON.stringify(body, null, 2),
          "utf8",
        );
        // 转换后的 Chat 请求体（实际发给上游的）
        fs.writeFileSync(
          path.join(dir, `chat-${stamp}.json`),
          JSON.stringify(chatBody, null, 2),
          "utf8",
        );
        log(`[debug] 请求体已保存: ${dir}`);
      }

      try {
        const upstream = await fetch(targetUrl.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(chatBody),
        });
        const text = await upstream.text();
        if (!upstream.ok) {
          log(`上游 ${upstream.status}: ${text.slice(0, 300)}`);
          res.writeHead(upstream.status, { "content-type": "application/json" });
          res.end(text);
          return;
        }
        const chat = JSON.parse(text);
        const responses = chatToResponses(chat, body.model);
        if (chat.usage && typeof onUsage === "function") {
          void Promise.resolve(onUsage({
            provider,
            model: chat.model || body.model,
            usage: chat.usage,
            sourceEventId: chat.id,
          })).catch((error) => {
            log(`记录 Token 用量失败: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        log(`${body.model} -> ${targetUrl.host}${targetUrl.pathname} OK`);

        if (wantStream) {
          // Codex 默认走流式，需要 SSE 事件序列
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const sse = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          sse("response.created", { type: "response.created", response: { ...responses, status: "in_progress", output: [] } });
          sse("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: responses.output[0]?.id, type: "message", status: "in_progress", role: "assistant", content: [] },
          });
          sse("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: responses.output_text || "",
          });
          sse("response.output_text.done", {
            type: "response.output_text.done",
            output_index: 0,
            content_index: 0,
            text: responses.output_text || "",
          });
          sse("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: responses.output[0],
          });
          sse("response.completed", { type: "response.completed", response: responses });
          res.end();
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responses));
      } catch (error) {
        log(`代理错误: ${error.message}`);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `proxy error: ${error.message}` } }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      // 端口已被占用：说明已有代理在跑，直接复用（不致命）
      if (error.code === "EADDRINUSE") {
        log(`端口 ${port} 已被占用，复用已有代理`);
        server.close();
        resolve(null);
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// CLI 模式
if (process.argv[1] && process.argv[1].endsWith("responses-chat-proxy.mjs")) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, cur, i, arr) => {
      if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]?.startsWith("--") ? "true" : arr[i + 1]]);
      return acc;
    }, []),
  );
  if (!args.port || !args.target || !args.key) {
    console.error("用法: node responses-chat-proxy.mjs --port <端口> --target <chat base url> --key <API Key>");
    process.exit(1);
  }
  await startProxy({
    port: Number(args.port),
    target: args.target,
    key: args.key,
    log: (m) => console.log(`[proxy] ${m}`),
  });
  console.log(`✅ 代理已启动 http://127.0.0.1:${args.port}/responses -> ${args.target}/chat/completions`);
}
