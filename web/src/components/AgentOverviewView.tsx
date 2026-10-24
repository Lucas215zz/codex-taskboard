import { useMemo, useState } from "react";

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

interface AgentGroup {
  key: string;
  name: string;
  actor: ActorIdentity | null;
  tasks: Task[];
  openCount: number;
  doneCount: number;
  lastActivityAt: string;
}

const COLLAPSED_ROWS = 4;
const LANE_WIDTH = 232;
const LANE_GAP = 12;

const STATUS_RANK: Record<TaskStatus, number> = {
  blocked: 0,
  in_progress: 1,
  in_review: 2,
  todo: 3,
  backlog: 4,
  done: 5,
  canceled: 6,
};

function isOpenTask(task: Task) {
  return task.status !== "done" && task.status !== "canceled";
}

function sortTasksForAgentView(left: Task, right: Task) {
  const rank = STATUS_RANK[left.status] - STATUS_RANK[right.status];
  if (rank !== 0) return rank;
  return right.activityUpdatedAt.localeCompare(left.activityUpdatedAt);
}

function buildGroups(
  tasks: Task[],
  isAllProjects: boolean,
  projectNames: Record<string, string>,
): AgentGroup[] {
  const buckets = new Map<string, { name: string; actor: ActorIdentity | null; tasks: Task[] }>();
  for (const task of tasks) {
    const key = isAllProjects
      ? task.projectId
      : `${task.assignee.type}:${task.assignee.id}`;
    const name = isAllProjects
      ? projectNames[task.projectId] ?? task.projectId
      : task.assignee.name;
    const actor = isAllProjects ? null : task.assignee;
    const bucket = buckets.get(key);
    if (bucket) bucket.tasks.push(task);
    else buckets.set(key, { name, actor, tasks: [task] });
  }

  return [...buckets.entries()]
    .map(([key, bucket]) => {
      const sorted = [...bucket.tasks].sort(sortTasksForAgentView);
      return {
        key,
        name: bucket.name,
        actor: bucket.actor,
        tasks: sorted,
        openCount: sorted.filter(isOpenTask).length,
        doneCount: sorted.filter((task) => task.status === "done").length,
        lastActivityAt: sorted.reduce(
          (latest, task) => (task.activityUpdatedAt > latest ? task.activityUpdatedAt : latest),
          sorted[0]?.activityUpdatedAt ?? new Date(0).toISOString(),
        ),
      };
    })
    .sort((left, right) => (
      right.openCount - left.openCount
      || right.tasks.length - left.tasks.length
      || Number(right.actor?.type === "agent") - Number(left.actor?.type === "agent")
      || left.name.localeCompare(right.name)
    ));
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

  const groups = useMemo(
    () => buildGroups(tasks, isAllProjects, projectNames),
    [isAllProjects, projectNames, tasks],
  );

  const unreadCount = useMemo(
    () => tasks.filter((task) => presentations[task.id]?.unread).length,
    [presentations, tasks],
  );
  const runningCount = useMemo(
    () => tasks.filter((task) => presentations[task.id]?.processing.running).length,
    [presentations, tasks],
  );
  const openCount = useMemo(() => tasks.filter(isOpenTask).length, [tasks]);
  const todayKey = localDayKey(new Date());
  const todayUpdateCount = useMemo(
    () => tasks.filter(
      (task) => localDayKey(new Date(task.activityUpdatedAt)) === todayKey,
    ).length,
    [tasks, todayKey],
  );
  const lastUpdateAt = useMemo(
    () => tasks.reduce(
      (latest, task) => (task.activityUpdatedAt > latest ? task.activityUpdatedAt : latest),
      "",
    ),
    [tasks],
  );

  const statusLine = automation.activeCount > 0
    ? text(
        `自动认领 · 每 ${automation.intervalMinutes ?? 0} 分钟`,
        `Auto-claim · every ${automation.intervalMinutes ?? 0} min`,
      )
    : text("自动认领未开启", "Auto-claim is off");
  const activityLine = text(
    `今日 ${todayUpdateCount} 次更新 · 运行中 ${runningCount}`,
    `${todayUpdateCount} updates today · ${runningCount} running`,
  );
  const laneSpan = groups.length * LANE_WIDTH + Math.max(0, groups.length - 1) * LANE_GAP;

  return (
    <div className="agent-overview">
      <div className="agent-overview-canvas">
        <div className="agent-overview-hero">
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

          <div className="agent-hero-chips">
            <span>
              <i className="agent-chip-mark" aria-hidden="true" />
              {text(`待处理 ${openCount}`, `${openCount} open`)}
            </span>
            <span>
              <i className="agent-chip-mark is-up" aria-hidden="true" />
              {lastUpdateAt
                ? text(`最近更新 ${timeLabel(lastUpdateAt, locale)}`, `Last update ${timeLabel(lastUpdateAt, locale)}`)
                : text("暂无更新", "No updates yet")}
            </span>
          </div>

          <div className="agent-hub">
            <img className="agent-hub-mark" src="codex-agent-logo.png" alt="" aria-hidden="true" />
            <div className="agent-hub-copy">
              <strong>Codex Agent</strong>
              <span>{statusLine}</span>
              <small>{activityLine}</small>
            </div>
            <span className={`agent-hub-state${automation.activeCount > 0 ? " is-on" : ""}`}>
              {automation.activeCount > 0 ? text("已在岗", "On duty") : text("待机", "Standby")}
            </span>
          </div>
          <span className="agent-hero-stem" aria-hidden="true" />
        </div>

        <div className="agent-overview-caption">
          <span>{isAllProjects ? text("业务线", "Business lines") : text("执行者", "Assignees")}</span>
          <i aria-hidden="true" />
          <span>{text(`${groups.length} 条`, `${groups.length} lanes`)}</span>
        </div>

        <div className="agent-overview-lanes-wrap">
          <div className="agent-overview-scroll">
            <div
              className="agent-overview-columns"
              style={{ minWidth: `${laneSpan}px` }}
            >
              <span className="agent-lane-rail" aria-hidden="true" />
              <div className="agent-overview-lanes">
                {groups.map((group) => (
                  <AgentColumn
                    key={group.key}
                    group={group}
                    presentations={presentations}
                  language={language}
                    locale={locale}
                    text={text}
                    onOpenTask={onOpenTask}
                  />
                ))}
                {groups.length === 0 && (
                  <div className="agent-overview-empty">
                    {text("当前范围内还没有议题", "No issues in this scope yet")}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentColumn({
  group,
  presentations,
  language,
  locale,
  text,
  onOpenTask,
}: {
  group: AgentGroup;
  presentations: Record<string, TaskCardPresentation>;
  language: TaskboardLanguage;
  locale: string;
  text: (chinese: string, english: string) => string;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleTasks = expanded ? group.tasks : group.tasks.slice(0, COLLAPSED_ROWS);
  const hiddenCount = group.tasks.length - visibleTasks.length;

  return (
    <section className="agent-column">
      <div className="agent-column-node" aria-hidden="true" />
      <header className="agent-column-header">
        {group.actor
          ? <ActorAvatar actor={group.actor} className="agent-column-avatar" />
          : <span className="agent-column-dot" aria-hidden="true" />}
        <strong>{group.name}</strong>
        <span className="agent-column-time">{timeLabel(group.lastActivityAt, locale)}</span>
      </header>

      <div className="agent-column-metrics">
        <div>
          <span>{text("未完成", "Open")}</span>
          <strong>{group.openCount}</strong>
        </div>
        <div>
          <span>{text("已完成", "Done")}</span>
          <strong>{group.doneCount}</strong>
        </div>
        <div>
          <span>{text("全部", "Total")}</span>
          <strong>{group.tasks.length}</strong>
        </div>
      </div>

      <div className="agent-column-rows">
        {visibleTasks.map((task) => (
          <button
            type="button"
            className={`agent-row status-${task.status}`}
            key={task.id}
            onClick={() => onOpenTask(task)}
            title={task.title}
          >
            <span className="agent-row-dot" aria-hidden="true" />
            <span className="agent-row-id">{task.externalKey ?? task.identifier}</span>
            <span className="agent-row-title">{task.title}</span>
            <span className="agent-row-meta">
              {presentations[task.id]?.processing.running
                ? text("运行中", "Running")
                : taskStatusLabel(language, task.status)}
            </span>
          </button>
        ))}
        {group.tasks.length === 0 && (
          <div className="agent-column-empty">{text("暂无议题", "No issues")}</div>
        )}
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          className="agent-column-more"
          onClick={() => setExpanded(true)}
        >
          {text(`展开全部 ${group.tasks.length} 个`, `Show all ${group.tasks.length}`)}
        </button>
      )}
      {expanded && group.tasks.length > COLLAPSED_ROWS && (
        <button
          type="button"
          className="agent-column-more"
          onClick={() => setExpanded(false)}
        >
          {text("收起", "Collapse")}
        </button>
      )}
    </section>
  );
}
