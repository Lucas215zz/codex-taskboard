import { useCallback, useMemo, useState } from "react";

import "./AgentOverviewView.css";
import { useTaskboardI18n, taskStatusLabel } from "../i18n";
import type { TaskboardLanguage } from "../i18n";
import type { ActorIdentity, Project, Task } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { updateProjectMetric } from "../api";

export interface AgentAutomationSummary {
  activeCount: number;
  intervalMinutes: number | null;
}

interface AgentOverviewViewProps {
  isAllProjects: boolean;
  currentUser: ActorIdentity;
  tasks: Task[];
  projects: Project[];
  presentations: Record<string, TaskCardPresentation>;
  projectNames: Record<string, string>;
  automation: AgentAutomationSummary;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
  onSelectProject: (projectId: string) => void;
  onProjectMetricUpdated: (project: Project) => void;
}

const DAY_MS = 86_400_000;
const STALE_DAYS = 7;
const QUIET_DAYS = 3;
const RECENT_TASKS_PER_PROJECT = 5;
const HIDE_NAMES_KEY = "taskboard:hideProjectNames";

type HealthTone = "active" | "quiet" | "stalled" | "empty";

interface ProjectHealth {
  id: string;
  name: string;
  total: number;
  open: number;
  waitingOnYou: number;
  quietDays: number;
  doneLast7: number;
  tone: HealthTone;
}

function daysSince(value: string | null | undefined, now: number) {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
}

function isOpenTask(task: Task) {
  return task.status !== "done" && task.status !== "canceled";
}

function healthTone(total: number, quietDays: number): HealthTone {
  if (total === 0) return "empty";
  if (quietDays >= STALE_DAYS) return "stalled";
  if (quietDays >= QUIET_DAYS) return "quiet";
  return "active";
}

function relativeDayLabel(days: number, language: TaskboardLanguage) {
  if (!Number.isFinite(days)) return language === "zh" ? "从未" : "never";
  if (days === 0) return language === "zh" ? "今天" : "today";
  if (days === 1) return language === "zh" ? "昨天" : "yesterday";
  return language === "zh" ? `${days} 天前` : `${days}d ago`;
}

function timeLabel(date: Date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/* ---------- project card ---------- */

interface ProjectCardProps {
  health: ProjectHealth;
  tasks: Task[];
  language: TaskboardLanguage;
  text: (zh: string, en: string) => string;
  hideNames: boolean;
  displayIndex: number;
  presentations: Record<string, TaskCardPresentation>;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
  onSelectProject: (projectId: string) => void;
  onProjectMetricUpdated: (project: Project) => void;
  project: Project;
}

function ProjectCard({
  health,
  tasks,
  language,
  text,
  hideNames,
  displayIndex,
  presentations,
  onOpenTask,
  onSelectProject,
  onProjectMetricUpdated,
  project,
}: ProjectCardProps) {
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editValue, setEditValue] = useState("");

  const displayName = hideNames
    ? `${text("项目", "Project")} ${String.fromCharCode(65 + displayIndex)}`
    : health.name;

  const metricLabel = project.mainMetricLabel;
  const metricValue = project.mainMetricValue;

  const recentTasks = useMemo(() => tasks
    .filter((task) => task.projectId === health.id)
    .sort((left, right) => right.activityUpdatedAt.localeCompare(left.activityUpdatedAt))
    .slice(0, RECENT_TASKS_PER_PROJECT),
  [tasks, health.id]);

  const openCount = tasks.filter(
    (task) => task.projectId === health.id && task.status === "in_progress",
  ).length;
  const waitingCount = tasks.filter(
    (task) => task.projectId === health.id
      && (task.status === "in_review" || task.status === "blocked"),
  ).length;

  const startEdit = useCallback(() => {
    setEditLabel(metricLabel ?? "");
    setEditValue(metricValue ?? "");
    setEditing(true);
  }, [metricLabel, metricValue]);

  const saveEdit = useCallback(async () => {
    const label = editLabel.trim() || null;
    const value = editValue.trim() || null;
    setEditing(false);
    try {
      const updated = await updateProjectMetric(health.id, {
        mainMetricLabel: label,
        mainMetricValue: value,
      });
      onProjectMetricUpdated(updated);
    } catch {
      // Silently revert — the next refresh will restore the true state.
    }
  }, [editLabel, editValue, health.id, onProjectMetricUpdated]);

  const toneIcon: Record<HealthTone, string> = {
    active: "●",
    quiet: "◐",
    stalled: "○",
    empty: "◌",
  };

  return (
    <div className={`cockpit-project tone-${health.tone}`}>
      {/* metric area */}
      <div className="cockpit-project-metric">
        {editing ? (
          <div className="cockpit-metric-edit">
            <input
              className="cockpit-metric-input"
              placeholder={text("指标名称", "Metric label")}
              value={editLabel}
              onChange={(event) => setEditLabel(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void saveEdit(); }}
              autoFocus
            />
            <input
              className="cockpit-metric-input"
              placeholder={text("数值", "Value")}
              value={editValue}
              onChange={(event) => setEditValue(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void saveEdit(); }}
            />
            <div className="cockpit-metric-actions">
              <button type="button" onClick={() => void saveEdit()}>
                {text("确定", "Save")}
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                {text("取消", "Cancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {metricValue && metricLabel ? (
              <div className="cockpit-metric-custom">
                <strong>{metricValue}</strong>
                <span>{metricLabel}</span>
              </div>
            ) : (
              <div className="cockpit-metric-auto">
                <strong>{health.doneLast7}</strong>
                <span>{text("7 天交付", "7d shipped")}</span>
              </div>
            )}
            <button
              type="button"
              className="cockpit-metric-edit-btn"
              onClick={startEdit}
              title={text("编辑主指标", "Edit main metric")}
              aria-label={text("编辑主指标", "Edit main metric")}
            >
              ✎
            </button>
          </>
        )}
      </div>

      {/* header */}
      <button
        type="button"
        className="cockpit-project-head"
        onClick={() => onSelectProject(health.id)}
      >
        <span className="cockpit-project-icon" aria-hidden="true">
          {toneIcon[health.tone]}
        </span>
        <span className="cockpit-project-name">{displayName}</span>
        <span className="cockpit-project-badge">
          {openCount > 0 && (
            <em className="is-active">{openCount} {text("在做", "active")}</em>
          )}
          {waitingCount > 0 && (
            <em className="is-waiting">{waitingCount} {text("等你", "for you")}</em>
          )}
        </span>
      </button>

      {/* stats row */}
      <div className="cockpit-project-stats">
        <span>{health.open} {text("未结束", "open")}</span>
        <i aria-hidden="true">·</i>
        <span>{text("动静", "last")} {relativeDayLabel(health.quietDays, language)}</span>
      </div>

      {/* recent tasks */}
      {recentTasks.length > 0 && (
        <div className="cockpit-project-tasks">
          {recentTasks.map((task) => {
            const presentation = presentations[task.id];
            const isUnread = presentation?.unread ?? false;
            return (
              <button
                type="button"
                className={`cockpit-task${isUnread ? " is-unread" : ""}`}
                key={task.id}
                onClick={() => onOpenTask(task)}
                title={task.title}
              >
                <span className={`cockpit-task-dot tone-${task.status}`} aria-hidden="true" />
                <span className="cockpit-task-title">{task.title}</span>
                <span className="cockpit-task-status">
                  {taskStatusLabel(language, task.status)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- main view ---------- */

export function AgentOverviewView({
  isAllProjects,
  currentUser,
  tasks,
  projects,
  presentations,
  projectNames,
  automation,
  onOpenTask,
  onSelectProject,
  onProjectMetricUpdated,
}: AgentOverviewViewProps) {
  const { language, text } = useTaskboardI18n();
  const now = Date.now();
  const nowDate = new Date();

  const [hideNames, setHideNames] = useState(() => {
    try { return localStorage.getItem(HIDE_NAMES_KEY) === "1"; } catch { return false; }
  });
  const toggleHideNames = useCallback(() => {
    setHideNames((previous) => {
      const next = !previous;
      try { localStorage.setItem(HIDE_NAMES_KEY, next ? "1" : "0"); } catch { /* noop */ }
      return next;
    });
  }, []);

  const waitingOnYou = useMemo(() => tasks
    .filter((task) => task.status === "in_review" || task.status === "blocked")
    .sort((left, right) => {
      const leftUnread = presentations[left.id]?.unread ? 1 : 0;
      const rightUnread = presentations[right.id]?.unread ? 1 : 0;
      return rightUnread - leftUnread
        || left.activityUpdatedAt.localeCompare(right.activityUpdatedAt);
    }), [presentations, tasks]);

  const agentQueue = useMemo(() => tasks
    .filter((task) => task.status === "in_progress")
    .sort((left, right) => left.activityUpdatedAt.localeCompare(right.activityUpdatedAt)),
  [tasks]);

  const health = useMemo<ProjectHealth[]>(() => {
    const scope = isAllProjects
      ? projects
      : projects.filter((project) => tasks.some((task) => task.projectId === project.id));
    return scope.map((project) => {
      const projectTasks = tasks.filter((task) => task.projectId === project.id);
      const open = projectTasks.filter(isOpenTask);
      const latest = projectTasks.reduce<string | null>(
        (value, task) => {
          const candidate = task.activityUpdatedAt > task.updatedAt
            ? task.activityUpdatedAt
            : task.updatedAt;
          return !value || candidate > value ? candidate : value;
        },
        null,
      );
      const quietDays = daysSince(latest, now);
      return {
        id: project.id,
        name: projectNames[project.id] ?? project.name,
        total: projectTasks.length,
        open: open.length,
        waitingOnYou: projectTasks.filter(
          (task) => task.status === "in_review" || task.status === "blocked",
        ).length,
        quietDays,
        doneLast7: projectTasks.filter(
          (task) => task.status === "done" && daysSince(task.updatedAt, now) <= 7,
        ).length,
        tone: healthTone(projectTasks.length, quietDays),
      };
    }).sort((left, right) => {
      const rank: Record<HealthTone, number> = { stalled: 0, quiet: 1, active: 2, empty: 3 };
      return rank[left.tone] - rank[right.tone]
        || right.waitingOnYou - left.waitingOnYou
        || right.quietDays - left.quietDays
        || left.name.localeCompare(right.name);
    });
  }, [isAllProjects, now, projectNames, projects, tasks]);

  const stalledProjects = health.filter((project) => project.tone === "stalled");
  const activeProjects = health.filter((project) => project.tone === "active");
  const emptyProjects = health.filter((project) => project.tone === "empty");
  const openCount = tasks.filter(isOpenTask).length;
  const unreadCount = waitingOnYou.filter((task) => presentations[task.id]?.unread).length;
  const doneLast7 = tasks.filter(
    (task) => task.status === "done" && daysSince(task.updatedAt, now) <= 7,
  ).length;

  const statusLine = automation.activeCount > 0
    ? text(
        `自动认领 · 每 ${automation.intervalMinutes ?? 0} 分钟`,
        `Auto-claim · every ${automation.intervalMinutes ?? 0} min`,
      )
    : text("自动认领未开启", "Auto-claim is off");

  return (
    <div className="agent-overview cockpit">
      <div className="cockpit-canvas">
        {/* top status bar */}
        <header className="cockpit-topbar">
          <div className="cockpit-topbar-brand">
            <span className="cockpit-logo" aria-hidden="true">◆</span>
            <span className="cockpit-brand-name">Taskboard</span>
            <span className="cockpit-brand-sub">{text("公司运营驾驶舱", "Operations Cockpit")}</span>
          </div>
          <div className="cockpit-topbar-stats">
            <span className="cockpit-stat">
              {health.length} {text("个项目", "projects")}
            </span>
            <span className="cockpit-stat">
              {tasks.length} {text("个议题", "issues")}
            </span>
            <span className="cockpit-stat">
              {openCount} {text("个未结束", "open")}
            </span>
            <span className="cockpit-stat">
              {activeProjects.length} {text("个活跃", "active")}
            </span>
          </div>
          <div className="cockpit-topbar-right">
            <span className="cockpit-time">{timeLabel(nowDate)}</span>
            <button
              type="button"
              className={`cockpit-hide-toggle${hideNames ? " is-on" : ""}`}
              onClick={toggleHideNames}
              title={hideNames ? text("显示项目名", "Show names") : text("隐藏项目名", "Hide names")}
            >
              {hideNames ? text("隐藏店名", "Hide names") : text("显示店名", "Show names")}
            </button>
          </div>
        </header>

        {/* you */}
        <section className="cockpit-user">
          <div className="cockpit-user-card">
            <ActorAvatar actor={currentUser} className="cockpit-user-avatar" />
            <div className="cockpit-user-info">
              <strong>{currentUser.name}</strong>
              <span>{text("创始人 · 拍板定方向", "Founder · Sets direction")}</span>
            </div>
            <div className="cockpit-user-badge">
              {waitingOnYou.length > 0 ? (
                <span className="cockpit-badge-hot">
                  {text(`等你 ${waitingOnYou.length} 件`, `${waitingOnYou.length} waiting`)}
                </span>
              ) : (
                <span className="cockpit-badge-calm">
                  {text("没有等你的事", "Nothing waiting")}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* CEO Agent */}
        <section className="cockpit-ceo">
          {/* arrow from user */}
          <div className="cockpit-arrow-down" aria-hidden="true">
            <svg width="20" height="28" viewBox="0 0 20 28">
              <line x1="10" y1="0" x2="10" y2="22" stroke="var(--ck-line-bright)" strokeWidth="1" />
              <polyline points="4,18 10,24 16,18" fill="none" stroke="var(--ck-line-bright)" strokeWidth="1" />
            </svg>
          </div>
          <div className="cockpit-ceo-card">
            <div className="cockpit-ceo-icon" aria-hidden="true">◇</div>
            <div className="cockpit-ceo-info">
              <strong>CEO Agent</strong>
              <span>
                {automation.activeCount > 0
                  ? text(
                      `每 ${automation.intervalMinutes ?? 0} 分钟巡视 · 在做 ${agentQueue.length} 件`,
                      `Every ${automation.intervalMinutes ?? 0} min · ${agentQueue.length} running`,
                    )
                  : text("未开启自动巡视", "Auto-patrol is off")}
              </span>
            </div>
            <div className={`cockpit-ceo-status${automation.activeCount > 0 ? " is-on" : ""}`}>
              <i aria-hidden="true" />
              <span>{statusLine}</span>
            </div>
          </div>
          {/* connector lines */}
          <div className="cockpit-connectors" aria-hidden="true">
            <div className="cockpit-connector-hub" />
            <div className="cockpit-connector-spokes">
              {health.map((project) => (
                <div className="cockpit-spoke" key={project.id} />
              ))}
            </div>
          </div>
        </section>

        {/* project grid */}
        <section className="cockpit-grid">
          {health.map((project, index) => (
            <ProjectCard
              key={project.id}
              health={project}
              tasks={tasks}
              language={language}
              text={text}
              hideNames={hideNames}
              displayIndex={index}
              presentations={presentations}
              onOpenTask={onOpenTask}
              onSelectProject={onSelectProject}
              onProjectMetricUpdated={onProjectMetricUpdated}
              project={projects.find((candidate) => candidate.id === project.id)!}
            />
          ))}
        </section>

        {/* footer summary */}
        <footer className="cockpit-footer">
          <span>
            {doneLast7} {text("件 7 天交付", "shipped in 7d")}
          </span>
          <i aria-hidden="true">·</i>
          <span>
            {waitingOnYou.length} {text("件等你", "waiting on you")}
            {unreadCount > 0 && (
              <em className="cockpit-unread">
                ({unreadCount} {text("未读", "unread")})
              </em>
            )}
          </span>
          <i aria-hidden="true">·</i>
          <span>
            {stalledProjects.length} {text("个荒废", "starving")}
          </span>
          <i aria-hidden="true">·</i>
          <span>
            {emptyProjects.length} {text("个未开工", "not started")}
          </span>
        </footer>
      </div>
    </div>
  );
}
