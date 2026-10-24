// Codex 任务面板 · 共享配置
// 面板地址固定化：令牌写死在配置里，引擎无论以哪种方式启动（浏览器模式 / Codex 模式），
// 面板地址永远一致，浏览器书签、内置浏览器链接都不会失效。
export const PANEL_PORT = 47823;
export const PANEL_TOKEN = "9b8a160a-3343-4df6-a16f-9265ed6773f8";
export const PANEL_ORIGIN = `http://127.0.0.1:${PANEL_PORT}`;
export const PANEL_URL = `${PANEL_ORIGIN}/${PANEL_TOKEN}/`;
