import { useMemo } from "react";

import "./AgentOverviewView.css";
import { useTaskboardI18n, taskStatusLabel } from "../i18n";
import type { TaskboardLanguage } from "../i18n";
import type { ActorIdentity, Task, TaskStatus } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";

export interface AgentAutomationSummary {
  activeCount: number;
  intervalMinutes: number | null;
}

interface AgentOverviewViewProps {
  isAllProjects: boolean;
  currentUser: ActorIdentity;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  projectNames: Record<string, string>;
  automation: AgentAutomationSummary;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
}

interface FlowStage {
  key: string;
  status: TaskStatus;
  /** Verb shown on the connector leading into this stage. */
  enterVerb: readonly [string, string];
  caption: readonly [string, string];
}

const STAGES: FlowStage[] = [
  {
    key: "todo",
    status: "todo",
    enterVerb: ["派单", "Dispatch"],
    caption: ["等待 Agent 认领", "Waiting to be claimed"],
  },
  {
    key: "in_progress",
    status: "in_progress",
    enterVerb: ["认领", "Claim"],
    caption: ["Agent 正在执行", "Agent is working"],
  },
  {
    key: "in_review",
    status: "in_review",
    enterVerb: ["提交", "Submit"],
    caption: ["等待你验收", "Waiting for your review"],
  },
  {
    key: "done",
    status: "done",
    enterVerb: ["验收", "Accept"],
    caption: ["已交付", "Delivered"],
  },
];

const SIDE_LANES: FlowStage[] = [
  {
    key: "backlog",
    status: "backlog",
    enterVerb: ["立项", "Plan"],
    caption: ["尚未进入流水线", "Not in the pipeline yet"],
  },
  {
    key: "blocked",
    status: "blocked",
    enterVerb: ["卡住", "Stuck"],
    caption: ["需要外部输入", "Needs external input"],
  },
];

function isOpenTask(task: Task) {
  return task.status !== "done" && task.status !== "canceled";
}

function localDayKey(value: Date) {
  return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
}

function timeLabel(value: string, locale: string, now = new Date()) {
  const date = new Date(value);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (localDayKey(date) === localDayKey(now)) return time;
  const day = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
  }).format(date);
  return `${day} ${time}`;
}

function durationLabel(
  from: string,
  now: number,
  locale: string,
  text: (chinese: string, english: string) => string,
) {
  const minutes = Math.max(0, Math.round((now - new Date(from).getTime()) / 60_000));
  if (minutes < 1) return text("刚刚", "just now");
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}

export function AgentOverviewView({
  isAllProjects,
  currentUser,
  tasks,
  presentations,
  projectNames,
  automation,
  onOpenTask,
}: AgentOverviewViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const taskBuckets = useMemo(() => {
    const buckets = new Map<TaskStatus, Task[]>();
    for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked", "done"] as TaskStatus[]) {
      buckets.set(status, []);
    }
    for (const task of tasks) {
      buckets.get(task.status)?.push(task);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((left, right) => right.activityUpdatedAt.localeCompare(left.activityUpdatedAt));
    }
    return buckets;
  }, [tasks]);

  const now = Date.now();
  const todayKey = localDayKey(new Date(now));
  const unreadCount = tasks.filter((task) => presentations[task.id]?.unread).length;
  const openCount = tasks.filter(isOpenTask).length;
  const enteredToday = tasks.filter(
    (task) => localDayKey(new Date(task.createdAt)) === todayKey,
  ).length;
  const deliveredToday = (taskBuckets.get("done") ?? []).filter(
    (task) => localDayKey(new Date(task.activityUpdatedAt)) === todayKey,
  ).length;
  const blockedCount = (taskBuckets.get("blocked") ?? []).length;
  const inFlight = (taskBuckets.get("in_progress") ?? []).length
    + (taskBuckets.get("in_review") ?? []).length;

  const statusLine = automation.activeCount > 0
    ? text(
        `自动认领 · 每 ${automation.intervalMinutes ?? 0} 分钟`,
        `Auto-claim · every ${automation.intervalMinutes ?? 0} min`,
      )
    : text("自动认领未开启", "Auto-claim is off");

  return (
    <div className="agent-overview">
      <div className="agent-overview-canvas">
        <header className="agent-flow-hero">
          <div className="agent-owner">
            <ActorAvatar actor={currentUser} className="agent-owner-avatar" />
            <div className="agent-owner-copy">
              <strong>{currentUser.name}</strong>
              <small>{text("项目负责人", "Project owner")}</small>
            </div>
            <span className={`agent-owner-badge${unreadCount > 0 ? " is-active" : ""}`}>
              {text(`等你 ${unreadCount} 件`, `${unreadCount} waiting for you`)}
            </span>
          </div>

          <div className="agent-flow-arrow" aria-hidden="true" />

          <div className="agent-hub">
            <img className="agent-hub-mark" src="codex-agent-logo.png" alt="" aria-hidden="true" />
            <div className="agent-hub-copy">
              <strong>Codex Agent</strong>
              <span>{statusLine}</span>
            </div>
            <span className={`agent-hub-state${automation.activeCount > 0 ? " is-on" : ""}`}>
              {automation.activeCount > 0 ? text("已在岗", "On duty") : text("待机", "Standby")}
            </span>
          </div>

          <dl className="agent-flow-kpis">
            <div>
              <dt>{text("今日进入", "Entered today")}</dt>
              <dd>{enteredToday}</dd>
            </div>
            <div>
              <dt>{text("流转中", "In flight")}</dt>
              <dd>{inFlight}</dd>
            </div>
            <div>
              <dt>{text("今日交付", "Delivered today")}</dt>
              <dd>{deliveredToday}</dd>
            </div>
            <div className={blockedCount > 0 ? "is-alert" : undefined}>
              <dt>{text("卡住", "Stuck")}</dt>
              <dd>{blockedCount}</dd>
            </div>
          </dl>
        </header>

        <div className="agent-flow-scroll">
          <div className="agent-flow-track">
            {STAGES.map((stage, index) => {
              const stageTasks = taskBuckets.get(stage.status) ?? [];
              return (
                <div className="agent-flow-segment" key={stage.key}>
                  {index > 0 && (
                    <div className="agent-flow-connector" aria-hidden="true">
                      <span className="agent-flow-connector-verb">
                        {text(stage.enterVerb[0], stage.enterVerb[1])}
                      </span>
                      <span
                        className={`agent-flow-connector-line${
                          stageTasks.some((task) => presentations[task.id]?.processing.running)
                            ? " is-flowing"
                            : ""
                        }`}
                      >
                        <i />
                      </span>
                    </div>
                  )}
                  <FlowStageColumn
                    stage={stage}
                    index={index + 1}
                    tasks={stageTasks}
                    presentations={presentations}
                    language={language}
                    locale={locale}
                    text={text}
                    now={now}
                    projectNames={projectNames}
                    isAllProjects={isAllProjects}
                    onOpenTask={onOpenTask}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="agent-flow-side">
          {SIDE_LANES.map((lane) => (
            <FlowStageColumn
              key={lane.key}
              stage={lane}
              tasks={taskBuckets.get(lane.status) ?? []}
              side
              presentations={presentations}
              language={language}
              locale={locale}
              text={text}
              now={now}
              projectNames={projectNames}
              isAllProjects={isAllProjects}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>

        <footer className="agent-flow-foot">
          {text(
            `${tasks.length} 个议题 · ${openCount} 个未结束 · 自动认领${
              automation.activeCount > 0 ? "已开启" : "未开启"
            }`,
            `${tasks.length} issues · ${openCount} open · auto-claim ${
              automation.activeCount > 0 ? "on" : "off"
            }`,
          )}
        </footer>
      </div>
    </div>
  );
}

function FlowStageColumn({
  stage,
  index,
  tasks,
  side = false,
  presentations,
  language,
  locale,
  text,
  now,
  projectNames,
  isAllProjects,
  onOpenTask,
}: {
  stage: FlowStage;
  index?: number;
  tasks: Task[];
  side?: boolean;
  presentations: Record<string, TaskCardPresentation>;
  language: TaskboardLanguage;
  locale: string;
  text: (chinese: string, english: string) => string;
  now: number;
  projectNames: Record<string, string>;
  isAllProjects: boolean;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
}) {
  const oldest = tasks.reduce<string | null>(
    (value, task) => (!value || task.activityUpdatedAt < value ? task.activityUpdatedAt : value),
    null,
  );

  return (
    <section
      className={`agent-stage status-${stage.status}${side ? " is-side" : ""}`}
      aria-label={taskStatusLabel(language, stage.status)}
    >
      <header className="agent-stage-header">
        <span className="agent-stage-dot" aria-hidden="true" />
        {index !== undefined && <span className="agent-stage-index">{index}</span>}
        <strong>{taskStatusLabel(language, stage.status)}</strong>
        <b>{tasks.length}</b>
      </header>
      <p className="agent-stage-caption">{text(stage.caption[0], stage.caption[1])}</p>

      <div className="agent-stage-list">
        {tasks.map((task) => {
          const running = presentations[task.id]?.processing.running;
          const unread = presentations[task.id]?.unread;
          return (
            <button
              type="button"
              className={`agent-flow-card${running ? " is-running" : ""}${unread ? " is-unread" : ""}`}
              key={task.id}
              onClick={() => onOpenTask(task)}
              title={task.title}
            >
              <span className="agent-flow-card-top">
                <span className="agent-flow-card-id">{task.externalKey ?? task.identifier}</span>
                {running && (
                  <span className="agent-flow-card-running">{text("执行中", "Running")}</span>
                )}
                {!running && unread && (
                  <span className="agent-flow-card-unread">{text("未读", "Unread")}</span>
                )}
                <time>{timeLabel(task.activityUpdatedAt, locale)}</time>
              </span>
              <span className="agent-flow-card-title">{task.title}</span>
              <span className="agent-flow-card-foot">
                <ActorAvatar actor={task.assignee} className="agent-flow-card-avatar" />
                <span className="agent-flow-card-assignee">{task.assignee.name}</span>
                {isAllProjects && (
                  <span className="agent-flow-card-project">
                    {projectNames[task.projectId] ?? task.projectId}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        {tasks.length === 0 && (
          <div className="agent-stage-empty">{text("此阶段暂无议题", "Nothing in this stage")}</div>
        )}
      </div>

      {oldest && (
        <p className="agent-stage-age">
          {text("最久滞留", "Oldest")} {durationLabel(oldest, now, locale, text)}
        </p>
      )}
    </section>
  );
}
