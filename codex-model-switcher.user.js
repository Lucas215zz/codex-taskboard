// Codex 模型切换器 —— 增强原生模型菜单，接入 WorkBuddy 自定义模型
//
// 设计要点（全部经 2026-10-21 实测验证）：
//   1. 不拦截原生按钮。原生菜单的模型切换本身就是好的（会写 config.toml 的 model），
//      之前的拦截反而干扰了它。
//   2. 自定义模型通过 config.toml 的 model_catalog_json 注入，Codex 原生菜单会自动列出。
//   3. 跨服务商模型（如 claude-opus-4-7 走 kkidc、glm 走 zhipu）需要同时改 model_provider。
//      原生点选只写 model 不写 provider，所以顺序必须是：
//         先 config/batchWrite 写 model_provider → 再点原生菜单项写 model
//      这样两者都会正确落盘。
//
// 注入方式：scripts/codex-injector.mjs 风格的 CDP Runtime.evaluate
(() => {
  if (window.__codexModelSwitcherV2) return;
  window.__codexModelSwitcherV2 = true;

  // ---------------------------------------------------------------- 桥接
  function callAppServer(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const requestId = "ms-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage, true);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type !== "mcp-response") return;
        if (message.hostId !== "local") return;
        if (message.message?.id !== requestId) return;
        event.stopImmediatePropagation();
        if (message.message.error) {
          finish({ ok: false, error: message.message.error.message || "failed" });
          return;
        }
        finish({ ok: true, result: message.message.result });
      };
      const timer = window.setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
      window.addEventListener("message", onMessage, true);
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        finish({ ok: false, error: "bridge unavailable" });
        return;
      }
      Promise.resolve(
        bridge.sendMessageFromView({
          type: "mcp-request",
          hostId: "local",
          request: { id: requestId, method, params },
          priority: "interactive",
          source: "codex_model_switcher",
          timeoutMs,
          expiresAtMs: Date.now() + timeoutMs,
        }),
      ).catch((error) => finish({ ok: false, error: String(error) }));
    });
  }

  // ---------------------------------------------------------------- 模型 -> provider 映射
  // 由 inject-model-switcher.mjs 从 model-provider-map.json 动态注入，
  // 保证与 ~/.codex/model-catalog.json、config.toml 始终一致。
  // 下面这份是注入失败时的兜底，必须跟着 models.json 的新增模型一起补：
  // 漏了会导致 providerFor() 返回 null ->
  //   writeModelAndProvider() 直接失败、原生菜单只写 model 不写 provider ->
  //   请求带着别的模型名发给当前服务商（如 MiniMax 回
  //   "code: 2013 unknown model 'deepseek-flash'"），而且 ensureConsistent()
  //   因为查不到 provider 而静默跳过，错配会一直留着。
  // 官方模型也在映射里（provider = codex_local_access），
  // 这样从自定义模型切回官方模型时 provider 能正确写回，不会残留。
  let PROVIDER_MAP = {
    "claude-opus-4-7": "kkidc",
    "gpt-5.5-wb": "agentaipilot",
    "glm-5.3-flashx": "zhipu",
    "MiniMax-M3": "minimax",
    "MiniMax-M3.1-Flash": "minimax",
    "deepseek-flash": "deepseek",
  };
  if (window.__codexProviderMap && typeof window.__codexProviderMap === "object") {
    PROVIDER_MAP = window.__codexProviderMap;
  }

  // 自定义模型（WorkBuddy 同步过来的），菜单里带 (WB) 标识
  const CUSTOM_MODELS = new Set(
    Object.keys(PROVIDER_MAP).filter((id) => {
      const entry = (window.__codexCatalog || []).find((m) => m.id === id);
      return entry ? /\(WB\)/i.test(entry.displayName || "") : true;
    }),
  );

  function providerFor(modelId) {
    return PROVIDER_MAP[modelId] || null;
  }

  // ---------------------------------------------------------------- 模型目录缓存
  // 菜单项 DOM 里没有 slug，只有 Codex 美化过的显示名（如 "gpt-5.5 (WB)" -> "5.5 (WB)"），
  // 所以按 slug 文本匹配不可靠。改用权威顺序：
  //   model/list 的返回顺序 == 菜单项的渲染顺序（实测一致）
  // 因此用「菜单索引 <-> model/list 索引」定位，再叠加文本匹配做兜底。
  let CATALOG = null;        // [{ id, displayName }]
  let CATALOG_FETCHED = false;

  async function loadCatalog(force = false) {
    if (CATALOG && !force) return CATALOG;
    if (CATALOG_FETCHED && !force) return CATALOG || [];
    const res = await callAppServer("model/list", { includeHidden: true });
    if (!res.ok || !res.result?.data) return CATALOG || [];
    CATALOG = res.result.data.map((m) => ({ id: m.id, displayName: m.displayName || m.id }));
    CATALOG_FETCHED = true;
    return CATALOG;
  }

  // 把菜单文本归一化：转小写 + 去掉所有非字母数字字符
  // 必须去掉连字符和空格，否则 "6.1-Sol"(目录) 与 "6.1 Sol"(菜单) 无法匹配上，
  // 会导致整个菜单与模型目录错位一位。
  function norm(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // Codex 菜单里的显示名规则（实测）：
  //   "GPT-6.1-Sol"      -> "6.1 Sol"     （去掉 GPT- 前缀，连字符变空格）
  //   "gpt-5.5 (WB)"     -> "5.5 (WB)"
  //   "claude-opus-4-7 (WB)" -> "claude-opus-4-7 (WB)"（非 gpt- 系列原样保留）
  // 所以比较时要先剥掉 gpt- 前缀（大小写不敏感）。
  function stripGptPrefix(name) {
    return (name || "").replace(/^gpt-/i, "");
  }

  // 把 slug 归一化成可能出现在菜单里的形式：
  //   "gpt-5.5-wb"    -> "5.5 (wb)"   （Codex 剥掉 "gpt-" 前缀，保留 "(WB)" 标识）
  //   "claude-opus-4-7" -> "claude-opus-4-7 (wb)"（自定义模型都带 (WB) 标识）
  //
  // 注意：只有 slug 自带 -wb 后缀的才生成 "(wb)" 变体。
  // 否则官方 gpt-5.5 的变体集合会和自定义 gpt-5.5-wb 撞车
  // （两者归一化后都是 "55wb"），导致点「5.5」切到 WB 版本。
  function slugVariants(id) {
    const out = new Set([norm(id)]);
    const stripped = stripGptPrefix(id);
    out.add(norm(stripped));
    if (/-wb$/i.test(id)) {
      const base = stripped.replace(/-wb$/i, "");
      out.add(norm(base + " (wb)"));
      out.add(norm(id.replace(/-wb$/i, "") + " (wb)"));
      out.add(norm(stripped + " (wb)"));
    }
    return [...out];
  }

  // ---------------------------------------------------------------- 当前模型
  function currentModelId() {
    const checked = [...document.querySelectorAll('[role=menuitemradio][aria-checked="true"]')];
    if (checked.length) {
      const items = [...document.querySelectorAll('[role=menuitemradio]')];
      // 对齐优先（最可靠）
      if (CATALOG && CATALOG.length) {
        const aligned = alignMenuItems(items);
        const idx = items.indexOf(checked[0]);
        if (idx >= 0 && aligned[idx]) return aligned[idx];
      }
      // 兜底：文本匹配
      const text = (checked[0].textContent || "").trim();
      for (const id of Object.keys(PROVIDER_MAP)) {
        if (slugVariants(id).includes(norm(text))) return id;
      }
    }
    return window.__codexCurrentModel || null;
  }

  // ---------------------------------------------------------------- 写配置
  //
  // 同时写 model + model_provider。
  //
  // 为什么必须一起写：Codex 读 config.toml 时，model 和 model_provider 是
  // 一个「组合」——model=MiniMax-M3.1-Flash 配 model_provider=zhipu 时，
  // 请求会带着 MiniMax 的模型名发给智谱，智谱直接返回
  //   {"code":"1211","message":"模型不存在，请检查模型代码。"}
  // 这类错配是「点了原生菜单就换模型」时最容易留下的残留：
  // 原生菜单只写 model，我们的监听器只写 provider，两者一旦不同步就错配。
  // ⚠️ 本地路由器例外（2026-10-23 加）：
  // 老板的体系是「所有模型统一走 codex-model-router（127.0.0.1:8788），
  // 由路由器按模型名分流到各上游」。这种架构下 model 与 provider 是多对一，
  // 路由器负责真正的分流。此时若还按 PROVIDER_MAP 把 model_provider 改写成
  // 某个直连 provider（minimax/kkidc/...），就会绕开路由器、退回直连模式。
  // 因此检测到 custom 指向 127.0.0.1:8788 时，只写 model，不动 model_provider。
  async function isLocalRouterMode(cfg) {
    try {
      const providers = cfg?.model_providers || cfg?.modelProviders || null;
      const custom = providers?.custom;
      if (!custom) return false;
      const base = String(custom.base_url || custom.baseUrl || "");
      return base.includes("127.0.0.1:8788") || base.includes("localhost:8788");
    } catch {
      return false;
    }
  }

  async function writeModelAndProvider(modelId, cfg) {
    const provider = providerFor(modelId);
    if (!provider) return false;
    const edits = [{ keyPath: "model", mergeStrategy: "replace", value: modelId }];
    if (!(await isLocalRouterMode(cfg))) {
      edits.push({ keyPath: "model_provider", mergeStrategy: "replace", value: provider });
    }
    const result = await callAppServer("config/batchWrite", {
      edits,
      reloadUserConfig: true,
    });
    return !!result.ok;
  }

  // 校验磁盘上的 model 与 model_provider 是否自洽；
  // 不一致就按 PROVIDER_MAP 纠正回来。
  async function ensureConsistent() {
    const cur = await callAppServer("config/read", {}, 4000);
    const cfg = cur?.result?.config;
    const model = cfg?.model;
    const provider = cfg?.model_provider;
    if (!model) return { ok: true, model, provider };

    // 本地路由器模式：model_provider 保持 custom（路由器负责按模型名分流），
    // 不能按 PROVIDER_MAP 改写成直连 provider，否则会绕开路由器。
    if (await isLocalRouterMode(cfg)) {
      return { ok: true, model, provider, routerMode: true };
    }

    const expected = providerFor(model);
    if (expected && provider !== expected) {
      await writeModelAndProvider(model, cfg);
      return { ok: true, model, provider: expected, fixed: true };
    }
    return { ok: true, model, provider };
  }

  // ---------------------------------------------------------------- 点原生菜单项
  function clickNativeItem(modelId) {
    const items = [...document.querySelectorAll('[role=menuitemradio]')];
    if (!items.length) return false;

    // 1) 文本精确/前缀匹配（最可靠，前提是显示名带 slug）
    const variants = slugVariants(modelId);
    for (const it of items) {
      const t = norm(it.textContent);
      if (variants.includes(t)) { it.click(); return true; }
    }

    // 2) 显示名匹配：model/list 的 displayName 去掉 "gpt-" 前缀后与菜单文本比对
    const entry = (CATALOG || []).find((m) => m.id === modelId);
    if (entry) {
      const dn = norm(entry.displayName);
      const dnStripped = norm(stripGptPrefix(entry.displayName));
      for (const it of items) {
        const t = norm(it.textContent);
        if (t === dn || t === dnStripped) { it.click(); return true; }
      }
    }

    // 3) 索引匹配：菜单顺序 == model/list 顺序（实测一致）
    //    注意菜单第 0 项是"默认推荐模型集"，不属于任何模型，需要跳过
    if (CATALOG && CATALOG.length) {
      const catIdx = CATALOG.findIndex((m) => m.id === modelId);
      if (catIdx >= 0) {
        // 菜单里可能有额外的分组项，用文本长度/内容做一次对齐校验
        const candidates = items.filter((it) => {
          const t = norm(it.textContent);
          return t && t !== norm("默认推荐模型集") && t.length > 0;
        });
        // 优先按索引直接取（跳过第一个非模型项）
        const idx = catIdx;
        if (candidates[idx]) { candidates[idx].click(); return true; }
      }
    }

    return false;
  }

  // ---------------------------------------------------------------- 完整切换
  async function switchTo(modelId) {
    const provider = providerFor(modelId);
    if (!provider) {
      flash(`未知模型 ${modelId}，未找到对应服务商`);
      return false;
    }

    // 确保模型目录已加载（菜单反查 id 需要）
    await loadCatalog();

    // 先把 model + model_provider 一起写好（原生点选不会写 provider）
    const cfgNow = await callAppServer("config/read", {}, 4000);
    const wrote = await writeModelAndProvider(modelId, cfgNow?.result?.config);
    if (!wrote) {
      flash(`切换 ${modelId} 失败：无法写入配置`);
      return false;
    }

    // 再点原生菜单项，让 Codex 更新 UI（菜单点击只会重写 model，
    // 不会动 provider，所以前面那一步写的 provider 不会被覆盖）
    const clicked = clickNativeItem(modelId);
    if (!clicked) {
      flash(`已切换到 ${modelId}（${provider}，菜单项未找到但配置已写入）`);
    } else {
      flash(`已切换到 ${modelId}（${provider}）`);
    }
    window.__codexCurrentModel = modelId;
    return true;
  }

  // 调试钩子：把关键函数挂到 window，方便外部脚本/控制台排查。
  // 例如在 DevTools 里执行：
  //   await window.__codexSwitcher.switchTo("MiniMax-M3.1-Flash")
  //   await window.__codexSwitcher.ensureConsistent()
  window.__codexSwitcher = {
    switchTo,
    ensureConsistent,
    providerFor,
    readConfig: () => callAppServer("config/read", {}, 4000),
  };

  // ---------------------------------------------------------------- 提示条
  let flashTimer = null;
  function flash(text) {
    let el = document.getElementById("codex-model-switcher-flash");
    if (!el) {
      el = document.createElement("div");
      el.id = "codex-model-switcher-flash";
      el.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483001;" +
        "padding:8px 16px;border-radius:8px;background:#111;color:#fff;font-size:13px;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = "block";
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { el.style.display = "none"; }, 2400);
  }

  // ---------------------------------------------------------------- 菜单增强
  // 在原生菜单里追加一个分组标题 + 快捷切换入口，让用户知道自定义模型可用
  const STYLE_ID = "codex-model-switcher-v2-style";
  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #codex-model-switcher-v2-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 4px 8px 2px;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .02em;
        background: var(--color-token-list-hover-background, rgba(127,127,127,.18));
        color: var(--color-token-text-secondary, inherit);
        opacity: .85;
        cursor: default;
        user-select: none;
      }
      #codex-model-switcher-v2-badge .dot {
        width: 5px; height: 5px; border-radius: 50%;
        background: #22c55e;
      }
      #codex-model-switcher-v2-panel {
        position: fixed;
        z-index: 2147483000;
        box-sizing: border-box;
        width: 300px;
        max-height: 420px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 6px;
        border-radius: 12px;
        background: var(--color-token-surface, #1f1f1f);
        color: var(--color-token-foreground, #fff);
        box-shadow: 0 12px 40px rgba(0,0,0,.45);
        font-size: 13px;
      }
      #codex-model-switcher-v2-panel .grp {
        padding: 8px 10px 4px;
        font-size: 11px; font-weight: 600; opacity: .55;
        text-transform: uppercase; letter-spacing: .04em;
      }
      #codex-model-switcher-v2-panel .it {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; padding: 7px 10px; border-radius: 8px;
        cursor: pointer; user-select: none;
      }
      #codex-model-switcher-v2-panel .it:hover {
        background: var(--color-token-list-hover-background, rgba(255,255,255,.08));
      }
      #codex-model-switcher-v2-panel .it.cur {
        background: var(--color-token-list-hover-background, rgba(127,127,127,.22));
      }
      #codex-model-switcher-v2-panel .it.cur .nm::before {
        content: "";
        display: inline-block;
        width: 5px; height: 5px;
        border-radius: 50%;
        margin-right: 6px;
        vertical-align: middle;
        background: #22c55e;
      }
      #codex-model-switcher-v2-panel .it .nm {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #codex-model-switcher-v2-panel .it .pid {
        font-size: 10px; opacity: .45; font-family: ui-monospace, monospace;
        flex: none;
      }
      #codex-model-switcher-v2-panel .hint {
        padding: 8px 10px 4px; font-size: 11px; opacity: .5; line-height: 1.5;
      }
      #codex-model-switcher-v2-quick:hover {
        opacity: 1;
        background: var(--color-token-list-hover-background, rgba(127,127,127,.18));
      }
    `;
    document.head.appendChild(style);
  }

  let panel = null;
  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  function buildPanel() {
    const p = document.createElement("div");
    p.id = "codex-model-switcher-v2-panel";
    p.setAttribute("role", "menu");

    const current = currentModelId();

    const addItem = (id, provider, label, tag) => {
      const item = document.createElement("div");
      item.className = "it" + (id === current ? " cur" : "");
      item.setAttribute("role", "menuitemradio");
      item.dataset.modelId = id;
      const name = document.createElement("span");
      name.className = "nm";
      name.textContent = label;
      const pid = document.createElement("span");
      pid.className = "pid";
      pid.textContent = tag || provider;
      item.appendChild(name);
      item.appendChild(pid);
      item.addEventListener("click", async () => {
        closePanel();
        await switchTo(id);
      });
      p.appendChild(item);
    };

    // ---- WorkBuddy 自定义模型
    const custom = Object.entries(PROVIDER_MAP).filter(([id]) => CUSTOM_MODELS.has(id));
    if (custom.length) {
      const head = document.createElement("div");
      head.className = "grp";
      head.textContent = "WorkBuddy 自定义模型";
      p.appendChild(head);
      for (const [id, provider] of custom) {
        const entry = (CATALOG || []).find((m) => m.id === id);
        addItem(id, provider, entry ? entry.displayName : id, provider);
      }
    }

    // ---- 官方模型（走中转站）
    const official = Object.entries(PROVIDER_MAP).filter(([id]) => !CUSTOM_MODELS.has(id));
    if (official.length) {
      const head2 = document.createElement("div");
      head2.className = "grp";
      head2.textContent = "官方模型";
      p.appendChild(head2);
      for (const [id, provider] of official) {
        const entry = (CATALOG || []).find((m) => m.id === id);
        addItem(id, provider, entry ? entry.displayName : id, provider);
      }
    }

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "切换会同时更新 model 与 model_provider，新会话立即生效。";
    p.appendChild(hint);
    return p;
  }

  function togglePanel(anchor) {
    if (panel) { closePanel(); return; }
    installStyles();
    panel = buildPanel();
    document.body.appendChild(panel);
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 300;
    const height = panel.offsetHeight || 300;
    let left = rect.left - width + rect.width;
    let top = rect.top - height - 8;
    if (top < 8) top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }

  // ---------------------------------------------------------------- 快捷入口
  // 在原生模型按钮旁插一个小的"WB"按钮，点开自定义模型快捷面板。
  // 找不到稳定的模型按钮锚点时静默跳过——原生菜单本身已经能用。
  function installQuickButton() {
    if (document.getElementById("codex-model-switcher-v2-quick")) return;
    const buttons = [...document.querySelectorAll('button,[role=button]')];
    const anchor = buttons.find((b) => {
      const t = (b.textContent || "").trim();
      return t && t.length < 40 && /推理强度|Sol|Astra|Luna|Terra|Flash|M3|glm|claude/i.test(t);
    });
    if (!anchor || !anchor.parentElement) return;

    const btn = document.createElement("button");
    btn.id = "codex-model-switcher-v2-quick";
    btn.type = "button";
    btn.textContent = "WB";
    btn.title = "WorkBuddy 模型快捷切换";
    btn.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;" +
      "height:22px;min-width:26px;padding:0 6px;margin-left:4px;border-radius:6px;" +
      "font-size:10px;font-weight:500;letter-spacing:.02em;cursor:pointer;" +
      "border:1px solid var(--color-token-border-secondary, rgba(127,127,127,.35));" +
      "background:transparent;color:inherit;opacity:.7;";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(btn);
    });
    anchor.parentElement.insertBefore(btn, anchor.nextSibling);
  }

  // ---------------------------------------------------------------- 菜单注入
  // 原生菜单每次打开都会重新渲染，所以用 MutationObserver 持续注入标记
  function enhanceMenu() {
    const items = [...document.querySelectorAll('[role=menuitemradio]')];
    if (!items.length) return;
    if (document.getElementById("codex-model-switcher-v2-badge")) return;

    // 自定义模型在菜单里的显示名带 " (WB)" 标识（由 sync-codex-models.mjs 写入）
    const hasCustom = items.some((it) => /\(WB\)/i.test(it.textContent || ""));
    if (!hasCustom) return;

    // 在菜单顶部插入一个 badge，提示自定义模型可用
    const badge = document.createElement("div");
    badge.id = "codex-model-switcher-v2-badge";
    badge.innerHTML = `<span class="dot"></span><span>含 WorkBuddy 自定义模型</span>`;
    badge.title = "带 (WB) 标识的是从 WorkBuddy 同步过来的自定义模型";
    const anchor = items[0];
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(badge, anchor);
    }
  }

  // ---------------------------------------------------------------- 菜单项对齐
  // 菜单项 DOM 没有 slug，只有 Codex 美化过的显示名（如 "6.1 Sol"）。
  //
  // 关键结构（实测）：菜单第 0 项是「默认推荐模型集」这类分组标题，
  // **不对应任何模型**；从第 1 项起，菜单项与 model/list 顺序严格一一对应。
  //
  // 注意不能用"显示名匹配"来找起点——第 0 项的标题恰好会让第一个模型被抢走，
  // 导致整体错位一位。正确做法是先剥离标题项，再按下标对应。
  function alignMenuItems(items) {
    const out = new Array(items.length).fill(null);
    if (!CATALOG || !CATALOG.length) return out;

    // 找到第一个能对应上 catalog[0] 的菜单项作为起点
    const first = CATALOG[0];
    const dn = norm(first.displayName);
    const dnStripped = norm(stripGptPrefix(first.displayName));
    let start = -1;
    for (let i = 0; i < items.length; i++) {
      const t = norm(items[i].textContent);
      if (t === dn || t === dnStripped) { start = i; break; }
    }
    if (start < 0) {
      // 兜底：假定第 0 项是标题，从第 1 项开始对应
      start = items.length === CATALOG.length ? 1 : 0;
    }

    for (let k = 0; k < CATALOG.length; k++) {
      const idx = start + k;
      if (idx >= items.length) break;
      out[idx] = CATALOG[k].id;
    }
    return out;
  }

  // 点击原生菜单项后，如果切到了自定义模型，补写 model_provider
  // 菜单项 DOM 没有 slug，只能靠对齐/文本反查模型 id。
  function modelIdFromMenuItem(item, allItems) {
    const text = (item.textContent || "").trim();

    // 1) 对齐优先：菜单项与模型目录严格一一对应，最可靠
    //    （文本匹配在 "5.5" vs "5.5 (WB)" 这类近似名上会撞车）
    if (CATALOG && CATALOG.length) {
      const aligned = alignMenuItems(allItems);
      const idx = allItems.indexOf(item);
      if (idx >= 0 && aligned[idx]) return aligned[idx];
    }

    // 2) 文本直接匹配（对齐不可用时的兜底）
    for (const id of Object.keys(PROVIDER_MAP)) {
      if (slugVariants(id).includes(norm(text))) return id;
    }

    // 3) 兜底：显示名直接比对
    if (CATALOG) {
      for (const m of CATALOG) {
        const dn = norm(m.displayName);
        const dnStripped = norm(stripGptPrefix(m.displayName));
        if (norm(text) === dn || norm(text) === dnStripped) return m.id;
      }
    }
    return null;
  }

  function watchNativeClicks() {
    document.addEventListener("click", async (event) => {
      const item = event.target?.closest?.('[role=menuitemradio]');
      if (!item) return;
      // 忽略切换器自己面板里的项（那里已经走 switchTo）
      if (item.id && item.id.startsWith("codex-model-switcher")) return;
      if (item.closest?.("#codex-model-switcher-v2-panel")) return;

      const allItems = [...document.querySelectorAll('[role=menuitemradio]')];
      const modelId = modelIdFromMenuItem(item, allItems);
      if (!modelId || !PROVIDER_MAP[modelId]) return;

      const provider = PROVIDER_MAP[modelId];

      // 关键：原生菜单只写 model，不写 model_provider。
      // 我们必须在同一个 batchWrite 里把 model + model_provider 一起写，
      // 否则会留下「model 是 A、provider 是 B」的错配，
      // 请求就带着 A 的模型名发到 B 的服务商上（智谱会报"模型不存在"）。
      //
      // 之前这里只在 provider 不同时才写，而且只写 provider：
      //   const current = cur?.result?.config?.model_provider;
      //   if (current !== provider) { await writeConfig(modelId); }
      // 点原生菜单时，Codex 随后才异步写 model，
      // 于是 model 先变、provider 后变（或反之），中间态就是错配。
      //
      // 本地路由器模式下（custom → 127.0.0.1:8788）只写 model，
      // 不动 model_provider——否则会绕开路由器退回直连。
      const cfgNow = await callAppServer("config/read", {}, 4000);
      await writeModelAndProvider(modelId, cfgNow?.result?.config);
      window.__codexCurrentModel = modelId;
      flash(`已切换到 ${modelId}（${provider}）`);
    }, true);
  }

  const observer = new MutationObserver(() => {
    enhanceMenu();
    installQuickButton();
  });

  // 点击面板外部时关闭快捷面板
  function watchOutsideClick() {
    document.addEventListener("click", (event) => {
      if (!panel) return;
      if (event.target?.closest?.("#codex-model-switcher-v2-panel")) return;
      if (event.target?.closest?.("#codex-model-switcher-v2-quick")) return;
      closePanel();
    }, true);
  }

  const start = () => {
    installStyles();
    enhanceMenu();
    installQuickButton();
    watchNativeClicks();
    watchOutsideClick();
    observer.observe(document.body, { childList: true, subtree: true });
    // 预拉一次模型目录，供菜单点击反查 id 用
    loadCatalog().catch(() => {});
    // 自愈：启动时先检查 config.toml 里 model 与 model_provider 是否自洽。
    // 不自洽（比如 model=MiniMax-M3.1-Flash 配 provider=zhipu）就立刻纠正，
    // 否则用户会看到"模型不存在，请检查模型代码"这种服务商侧的报错。
    ensureConsistent()
      .then((r) => {
        if (r?.fixed) {
          flash(`已修正配置错配：${r.model} → ${r.provider}`);
        }
      })
      .catch(() => {});
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  window.addEventListener("beforeunload", () => observer.disconnect());
})();
