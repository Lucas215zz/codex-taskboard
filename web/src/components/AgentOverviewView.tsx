import { useMemo, useState } from "react";

import "./AgentOverviewView.css";
import { useTaskboardI18n, taskStatusLabel } from "../i18n";
import type { TaskboardLanguage } from "../i18n";
import type { ActorIdentity, Project, Task, TaskStatus } from "../types";
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
  projects: Project[];
  presentations: Record<string, TaskCardPresentation>;
  projectNames: Record<string, string>;
  automation: AgentAutomationSummary;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
  onSelectProject: (projectId: string) => void;
}

const DAY_MS = 86_400_000;
const STALE_DAYS = 7;
const QUIET_DAYS = 3;
const WAITING_LIMIT = 8;

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

/**
 * Health is driven by recency of activity, not by throughput: for a solo
 * operator the question is always "which project have I stopped touching".
 * A project with no issues is not healthy or sick, it is simply not started,
 * so it is kept out of the neglect ranking.
 */
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
}: AgentOverviewViewProps) {
  const { language, text } = useTaskboardI18n();
  const now = Date.now();

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

  const backlog = useMemo(() => tasks
    .filter((task) => task.status === "todo" || task.status === "backlog")
    .sort((left, right) => left.activityUpdatedAt.localeCompare(right.activityUpdatedAt)),
  [tasks]);

  const health = useMemo<ProjectHealth[]>(() => {
    // Scope follows the loaded task list: all projects when browsing everything,
    // otherwise just the project whose tasks are currently in memory.
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
  const nextMove = buildNextMove({
    waitingOnYou,
    stalledProjects,
    health,
    agentQueue,
  });
  const doneLast7 = tasks.filter(
    (task) => task.status === "done" && daysSince(task.updatedAt, now) <= 7,
  ).length;
  const openCount = tasks.filter(isOpenTask).length;
  const unreadCount = waitingOnYou.filter((task) => presentations[task.id]?.unread).length;
  const oldestWaiting = waitingOnYou[0] ?? null;

  const statusLine = automation.activeCount > 0
    ? text(
        `自动认领 · 每 ${automation.intervalMinutes ?? 0} 分钟`,
        `Auto-claim · every ${automation.intervalMinutes ?? 0} min`,
      )
    : text("自动认领未开启", "Auto-claim is off");

  return (
    <div className="agent-overview solo">
      <div className="solo-canvas">
        <header className="solo-head">
          <div className="solo-identity">
            <ActorAvatar actor={currentUser} className="solo-avatar" />
            <div>
              <strong>{currentUser.name}</strong>
              <small>{text("一人公司 · 项目操盘", "Solo operator")}</small>
            </div>
          </div>
          <div className={`solo-agent${automation.activeCount > 0 ? " is-on" : ""}`}>
            <img src="codex-agent-logo.png" alt="" aria-hidden="true" />
            <span>{statusLine}</span>
            <i aria-hidden="true" />
            {text(
              `在做 ${agentQueue.length}`,
              `${agentQueue.length} running`,
            )}
          </div>
        </header>

        <section className={`solo-verdict tone-${verdictTone(health, waitingOnYou.length)}`}>
          <p className="solo-verdict-line">{buildVerdict({
            isAllProjects,
            waiting: waitingOnYou.length,
            unread: unreadCount,
            oldestWaiting,
            stalled: stalledProjects,
            activeCount: activeProjects.length,
            emptyCount: health.filter((project) => project.tone === "empty").length,
            now,
            language,
            text,
          })}</p>
          {nextMove && (
            <button
              type="button"
              className="solo-next"
              onClick={() => {
                if (nextMove.task) onOpenTask(nextMove.task);
                else if (nextMove.projectId) onSelectProject(nextMove.projectId);
              }}
            >
              <span className="solo-next-label">{text("下一步", "Next step")}</span>
              <span className="solo-next-text">{nextMove.label}</span>
              <i aria-hidden="true" />
            </button>
          )}
          <dl className="solo-figures">
            <div className={waitingOnYou.length > 0 ? "is-hot" : undefined}>
              <dt>{text("该我处理", "Needs me")}</dt>
              <dd>{waitingOnYou.length}</dd>
            </div>
            <div>
              <dt>{text("Agent 在做", "Agent working")}</dt>
              <dd>{agentQueue.length}</dd>
            </div>
            <div>
              <dt>{text("排队中", "Queued")}</dt>
              <dd>{backlog.length}</dd>
            </div>
            <div className={stalledProjects.length > 0 ? "is-warn" : undefined}>
              <dt>{text("荒废项目", "Starving")}</dt>
              <dd>{stalledProjects.length}</dd>
            </div>
            <div>
              <dt>{text("7 天交付", "Shipped 7d")}</dt>
              <dd>{doneLast7}</dd>
            </div>
          </dl>
        </section>

        <div className="solo-main">
          <section className="solo-panel solo-focus">
            <header>
              <h2>{text("现在轮到你", "Your turn")}</h2>
              <span>{text(`${waitingOnYou.length} 件`, `${waitingOnYou.length} items`)}</span>
            </header>
            <div className="solo-list">
              {waitingOnYou.slice(0, WAITING_LIMIT).map((task) => (
                <button
                  type="button"
                  className={`solo-task tone-${task.status}`}
                  key={task.id}
                  onClick={() => onOpenTask(task)}
                  title={task.title}
                >
                  <span className="solo-task-mark" aria-hidden="true" />
                  <span className="solo-task-body">
                    <span className="solo-task-title">{task.title}</span>
                    <span className="solo-task-meta">
                      <b>{task.externalKey ?? task.identifier}</b>
                      <span>{projectNames[task.projectId] ?? task.projectId}</span>
                      <span className="solo-task-state">
                        {taskStatusLabel(language, task.status)}
                      </span>
                    </span>
                  </span>
                  <span className="solo-task-age">
                    {relativeDayLabel(daysSince(task.activityUpdatedAt, now), language)}
                  </span>
                </button>
              ))}
              {waitingOnYou.length === 0 && (
                <div className="solo-empty">
                  <strong>{text("现在没有等你的事", "Nothing waiting on you")}</strong>
                  <span>
                    {agentQueue.length > 0
                      ? text(
                          `Agent 还有 ${agentQueue.length} 件在做，做完会自动落到这里。`,
                          `Agent is working on ${agentQueue.length}. Finished work lands here.`,
                        )
                      : text(
                          "队列和 Agent 都空着，可以去推进最荒废的那个项目。",
                          "Queue and agent are both empty. Go push the most starved project.",
                        )}
                  </span>
                </div>
              )}
            </div>
          </section>

          <section className="solo-panel solo-health">
            <header>
              <h2>{text("项目体温", "Project health")}</h2>
              <span>{text(`${health.length} 个`, `${health.length} projects`)}</span>
            </header>
            <div className="solo-health-list">
              {health.map((project) => (
                <button
                  type="button"
                  className={`solo-project tone-${project.tone}`}
                  key={project.id}
                  onClick={() => onSelectProject(project.id)}
                  title={text(
                    `打开 ${project.name}`,
                    `Open ${project.name}`,
                  )}
                >
                  <span className="solo-project-bar" aria-hidden="true" />
                  <span className="solo-project-main">
                    <span className="solo-project-name">{project.name}</span>
                    <span className="solo-project-facts">
                      {project.total === 0
                        ? text("还没有议题", "No issues yet")
                        : text(
                            `${project.open} 未结束 · ${project.doneLast7} 件 7 天交付`,
                            `${project.open} open · ${project.doneLast7} shipped in 7d`,
                          )}
                    </span>
                  </span>
                  <span className="solo-project-tail">
                    {project.waitingOnYou > 0 && (
                      <b className="solo-project-waiting">
                        {text(`${project.waitingOnYou} 件等你`, `${project.waitingOnYou} for you`)}
                      </b>
                    )}
                    <span className="solo-project-quiet">
                      {text(
                        `动静 ${relativeDayLabel(project.quietDays, language)}`,
                        `Last ${relativeDayLabel(project.quietDays, language)}`,
                      )}
                    </span>
                  </span>
                </button>
              ))}
              {health.length === 0 && (
                <div className="solo-empty">
                  <strong>{text("还没有项目", "No projects yet")}</strong>
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="solo-flow">
          <span className="solo-flow-label">{text("流水线", "Pipeline")}</span>
          {FLOW.map((step, index) => {
            const count = tasks.filter((task) => task.status === step.status).length;
            return (
              <div className={`solo-flow-step tone-${step.status}`} key={step.status}>
                {index > 0 && <i className="solo-flow-arrow" aria-hidden="true" />}
                <span>{taskStatusLabel(language, step.status)}</span>
                <b>{count}</b>
              </div>
            );
          })}
          <span className="solo-flow-foot">
            {text(
              `共 ${tasks.length} 个议题 · ${openCount} 个未结束`,
              `${tasks.length} issues · ${openCount} open`,
            )}
          </span>
        </section>
      </div>
    </div>
  );
}

const FLOW: { status: TaskStatus }[] = [
  { status: "backlog" },
  { status: "todo" },
  { status: "in_progress" },
  { status: "in_review" },
  { status: "done" },
];

function verdictTone(health: ProjectHealth[], waiting: number) {
  if (health.some((project) => project.tone === "stalled")) return "warn";
  if (waiting > 0) return "hot";
  return "calm";
}

function buildVerdict({
  isAllProjects,
  waiting,
  unread,
  oldestWaiting,
  stalled,
  activeCount,
  emptyCount,
  now,
  language,
  text,
}: {
  isAllProjects: boolean;
  waiting: number;
  unread: number;
  oldestWaiting: Task | null;
  stalled: ProjectHealth[];
  activeCount: number;
  emptyCount: number;
  now: number;
  language: TaskboardLanguage;
  text: (chinese: string, english: string) => string;
}) {
  if (waiting > 0) {
    const age = oldestWaiting
      ? relativeDayLabel(daysSince(oldestWaiting.activityUpdatedAt, now), language)
      : "";
    return text(
      `${waiting} 件事在等你${unread > 0 ? `（${unread} 件未读）` : ""}，最久的一件候了 ${age}。`,
      `${waiting} items need you${unread > 0 ? ` (${unread} unread)` : ""}; oldest waiting ${age}.`,
    );
  }
  if (stalled.length > 0) {
    const names = stalled.slice(0, 2).map((project) => project.name).join("、");
    return text(
      `手头没有待办，但 ${names} 已经超过 ${STALE_DAYS} 天没动静了。`,
      `Nothing waiting, but ${names} has been quiet for ${STALE_DAYS}+ days.`,
    );
  }
  if (!isAllProjects) {
    return text(
      "这个项目的待办都清了，没有卡住的事。",
      "This project is clear — nothing pending or stuck.",
    );
  }
  if (emptyCount > 0) {
    return text(
      `${activeCount} 个在推进，${emptyCount} 个还没开工，没有项目掉队。`,
      `${activeCount} moving, ${emptyCount} not started — nothing is starving.`,
    );
  }
  return text(
    "所有项目都在近期有推进，没有掉队的。",
    "Every project has moved recently — nothing is starving.",
  );
}

interface NextMove {
  label: string;
  task?: Task;
  projectId?: string;
}

/**
 * One concrete suggestion instead of a dashboard full of numbers a solo
 * operator still has to interpret. Priority: unblock the review queue,
 * then restart a starving project, then give the empty pipeline a first issue.
 */
function buildNextMove({
  waitingOnYou,
  stalledProjects,
  health,
  agentQueue,
}: {
  waitingOnYou: Task[];
  stalledProjects: ProjectHealth[];
  health: ProjectHealth[];
  agentQueue: Task[];
}): NextMove | null {
  const oldest = waitingOnYou[0];
  if (oldest) {
    return {
      label: `${oldest.externalKey ?? oldest.identifier} ${oldest.title}`,
      task: oldest,
    };
  }
  if (stalledProjects.length > 0) {
    const target = stalledProjects[0];
    return {
      label: `回到 ${target.name}（${target.quietDays} 天没动）`,
      projectId: target.id,
    };
  }
  const notStarted = health.find((project) => project.tone === "empty");
  if (notStarted) {
    return {
      label: `给 ${notStarted.name} 立第一个议题`,
      projectId: notStarted.id,
    };
  }
  if (agentQueue.length > 0) {
    return { label: `等 Agent 做完 ${agentQueue.length} 件，暂时不用你` };
  }
  return null;
}

