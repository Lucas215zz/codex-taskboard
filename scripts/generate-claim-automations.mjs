// 生成「按项目隔离 + 按优先级认领」的统一自动化规格。
// 用法：node scripts/generate-claim-automations.mjs
// 产物：.data/claim-automation-<taskboardProjectId>.json
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskboardAutomationPrompt } from "../shared/taskboard-automation.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDir = path.join(repoRoot, ".data");
const skillPath = "C:\\Users\\phlus\\.agents\\skills\\manage-taskboard\\SKILL.md";

const projects = [
  {
    taskboardProjectId: "dashi-taskboard",
    projectName: "Dashi Taskboard",
    codexProjectId: "eb9a1a89-c303-4fe3-b9ae-56e87df1d8bd",
    workspacePath: "E:\\github\\dashi-taskboard-main",
  },
  {
    taskboardProjectId: "workbuddysub2",
    projectName: "WorkBuddySub2",
    codexProjectId: "ef950295-bddc-48dd-b6e2-b46bab5ec49d",
    workspacePath: "E:\\github\\workbuddysub2",
    extraInstructions: [
      "【本项目专属：缺少外部输入时的处理】",
      "如果任务确实需要某个还不存在的东西（域名、证书、密码、DNS 记录等），照常认领，把不依赖它的部分全部做完，然后：",
      "- 用 comment add 写清楚已经完成了什么、还缺什么、需要用户做什么；",
      "- 把状态留在 in_review，不要自行编造域名、证书、密码或任何配置值；",
      "- 不要因为缺输入就把整条任务原封不动退回去。",
      "【本项目专属：共享服务器红线】",
      "本项目要部署到共享服务器 43.139.139.96（SSH：ubuntu@43.139.139.96，私钥 C:\\Users\\phlus\\.ssh\\lusixian_srv.pem，sudo 免密）。该服务器上还有 cloud-mail、wchat_api、wxgzhfabu、wechat 等多个独立运行的项目。以下操作一律禁止：",
      "- 禁止 docker compose down -v、docker system prune、docker volume rm",
      "- 禁止 pm2 restart all、pm2 stop all（会连带影响 wxgzhfabu）",
      "- 禁止修改或禁用 /etc/nginx/conf.d/_main_ip_placeholder.conf，禁止让新配置带 default_server",
      "- 禁止触碰宿主机 PostgreSQL 的 ai_resources 库及其用户，禁止动 cloud-mail 的任何容器",
      "- 禁止占用 22 / 25 / 53 / 80 / 443 / 465 / 3010 / 3011 / 5432 / 8787",
      "- 禁止把任何密钥写进 PORTS.md、git 仓库或对外输出",
      "应用只写 /opt/apps/workbuddysub2，端口只绑 127.0.0.1:3000，占用前必须先在 /opt/apps/PORTS.md 登记。",
      "只做该议题描述要求的范围，不顺手改其他项目，不顺手重构。",
    ],
  },
  {
    taskboardProjectId: "ai",
    projectName: "AI知识库-小程序",
    codexProjectId: "fd3c62b7-f17e-4a36-9bb8-37db9c4dbfd1",
    workspacePath: "E:\\github\\微信小程序项目\\AI知识库-小程序",
  },
  {
    taskboardProjectId: "creatorpicks",
    projectName: "CreatorPicks",
    codexProjectId: "d121c554-f8f0-4c7b-93f6-aae9b1fde64b",
    workspacePath: "E:\\github\\work Buddy\\data\\2026-10-20-14-58-57",
    localEnvironmentConfigPath: "/E:\\github\\work Buddy\\data\\2026-10-20-14-58-57",
    extraInstructions: [
      "【本项目专属：共用工作目录时的冲突提醒】",
      "本项目的所有任务共用同一个工作目录，多个 Agent 同时改同一目录会互相覆盖。选定候选后、认领之前，把候选议题的开发上下文（threadBinding.workspacePath 或绑定的 branch/worktree）与当前每个 in_progress 任务的开发上下文逐一比较：优先选择开发上下文与所有在跑任务都不同的议题。",
      "只有当不存在这种安全选项时，才允许认领共用同一目录的议题，并且必须先用 comment add 在该议题写明「本条与 <在跑任务编号列表> 共用同一工作目录，注意文件冲突」，再执行认领。",
    ],
  },
  {
    taskboardProjectId: "d121c554-f8f0-4c7b-93f6-aae9b1fde64b",
    projectName: "TAP达人联盟网站",
    codexProjectId: "d121c554-f8f0-4c7b-93f6-aae9b1fde64b",
    workspacePath: "E:\\github\\CreatorPicks",
  },
  {
    taskboardProjectId: "local-128f6a0c673d4a9285f723c5c1700fe5",
    projectName: "MJFlow4.0",
    codexProjectId: "local-128f6a0c673d4a9285f723c5c1700fe5",
    workspacePath: "E:\\github\\MJFlow4.0",
  },
  {
    taskboardProjectId: "19b4b08c-4a2b-4bcd-a701-7cbb6a1bb6ce",
    projectName: "TIktok-Tap网站",
    // E:\github\TIktok-Tap网站\TIktok-Tap 目前还不是 Codex 项目（未在 Codex 侧注册），
    // 所以先挂到已有项目 d121c554 上，再用下面 prependInstructions 强制工作目录。
    // 等 Codex 侧把该目录注册为独立项目后，把 codexProjectId 改回
    // 19b4b08c-4a2b-4bcd-a701-7cbb6a1bb6ce 即可去掉这段兼容说明。
    codexProjectId: "d121c554-f8f0-4c7b-93f6-aae9b1fde64b",
    workspacePath: "E:\\github\\TIktok-Tap网站\\TIktok-Tap",
    localEnvironmentConfigPath: "/E:\\github\\TIktok-Tap网站\\TIktok-Tap",
    prependInstructions: [
      "【工作目录】本自动化只处理 Taskboard 的「TIktok-Tap网站」项目，所有代码读写、命令执行都必须在 E:\\github\\TIktok-Tap网站\\TIktok-Tap 目录内进行。每条命令前先切到该目录（PowerShell: Set-Location -LiteralPath 'E:\\github\\TIktok-Tap网站\\TIktok-Tap'），所有文件路径用该目录下的相对路径。禁止读取或修改本项目目录以外的任何文件。",
    ],
  },
];

const intervalMinutes = 5;
const model = "MiniMax-M3.1-Flash";
const reasoningEffort = "medium";

mkdirSync(outputDir, { recursive: true });

for (const project of projects) {
  const request = {
    taskboardProjectId: project.taskboardProjectId,
    projectName: project.projectName,
    codexProjectId: project.codexProjectId,
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: project.workspacePath,
    remoteProjects: [],
    skillPath,
    enabledByUser: true,
    quotaAware: true,
    intervalMinutes,
    model,
    reasoningEffort,
  };
  const prompt = [
    ...(project.prependInstructions ?? []),
    buildTaskboardAutomationPrompt(request),
    ...(project.extraInstructions ?? []),
  ].join("\n\n");
  const spec = {
    kind: "cron",
    name: `Taskboard 自动认领 · ${project.taskboardProjectId}`,
    prompt,
    projectId: project.codexProjectId,
    executionEnvironment: "local",
    localEnvironmentConfigPath: project.localEnvironmentConfigPath ?? null,
    model,
    reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${intervalMinutes}`,
  };
  const outputPath = path.join(outputDir, `claim-automation-${project.taskboardProjectId}.json`);
  writeFileSync(outputPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  console.log(`${outputPath}  (prompt ${prompt.length} chars)`);
}
