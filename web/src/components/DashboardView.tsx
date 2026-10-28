import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import "./DashboardView.css";
import processingAnimation from "../assets/figma-taskboard/loading-16.svg";
import { getProjectSummary } from "../api";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import { labelPresentation } from "../labels";
import { actorKey } from "../actors";
import type {
  TaskCardPresentation,
  TaskConversationItem,
} from "../taskConversations";
import type { ActorIdentity, ProjectSummary, Task } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { PriorityIcon } from "./SemanticIcons";
import { TaskConversationMenu } from "./TaskConversationMenu";

interface DashboardViewProps {
  projectId: string;
  projectsPanel?: ReactNode;
  isAllProjects: boolean;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  currentUser: ActorIdentity;
  animateSummary: boolean;
  onSummaryAnimationStart: (projectId: string) => void;
  onOpenTask: (task: Task) => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

const PRIORITIES = ["urgent", "high", "medium", "low", "none"] satisfies Task["priority"][];

const LABEL_COLORS = [
  "#5e6ad2",
  "#d25e5e",
  "#5eccd2",
  "#f9ac28",
  "#85d254",
  "#5482d2",
  "#bf49d7",
];

interface ProjectCompletion {
  parentCount: number;
  completedParents: number;
  percentage: number;
}

function calculateProjectCompletion(tasks: Task[]): ProjectCompletion {
  const activeTasks = tasks.filter((task) => task.status !== "canceled");
  const taskById = new Map(activeTasks.map((task) => [task.id, task]));
  const parents = activeTasks.filter((task) => (
    task.relations.parent === null
  ));

  if (parents.length === 0) {
    return { parentCount: 0, completedParents: 0, percentage: 0 };
  }

  const completedParents = parents.filter((task) => task.status === "done").length;
  const childContribution = parents.reduce((total, parent) => {
    if (parent.status === "done") return total;
    const children = parent.relations.subIssues
      .map((child) => taskById.get(child.id))
      .filter((child): child is Task => Boolean(child));
    if (children.length === 0) return total;
    return total + children.filter((child) => child.status === "done").length / children.length;
  }, 0);
  const parentCount = parents.length;
  const completion = (completedParents + childContribution) / parentCount;

  return {
    parentCount,
    completedParents,
    percentage: Math.round(completion * 100),
  };
}

function dateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayValue(value: string) {
  return new Date(`${value}T00:00:00`).getTime();
}

function DashboardSummary({
  projectId,
  summary,
  summaryReady,
  animateSummary,
  onSummaryAnimationStart,
}: Pick<DashboardViewProps, "projectId" | "animateSummary" | "onSummaryAnimationStart"> & {
  summary: string;
  summaryReady: boolean;
}) {
  const { text } = useTaskboardI18n();
  const [displayedSummary, setDisplayedSummary] = useState("");
  const [summaryTyping, setSummaryTyping] = useState(true);
  const [animateSummaryOnMount] = useState(animateSummary);
  const summaryAnimationStartedRef = useRef(false);
  const summaryTypedRef = useRef(false);

  useEffect(() => {
    if (!animateSummaryOnMount || summaryAnimationStartedRef.current) return;
    summaryAnimationStartedRef.current = true;
    onSummaryAnimationStart(projectId);
  }, [animateSummaryOnMount, onSummaryAnimationStart, projectId]);

  useEffect(() => {
    if (!summaryReady) {
      setDisplayedSummary("");
      setSummaryTyping(animateSummaryOnMount);
      return undefined;
    }

    if (!animateSummaryOnMount || summaryTypedRef.current) {
      setDisplayedSummary(summary);
      setSummaryTyping(false);
      return undefined;
    }

    const characters = Array.from(summary);
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;
    summaryTypedRef.current = true;
    setDisplayedSummary("");
    setSummaryTyping(true);

    function typeNextCharacter() {
      index += 1;
      setDisplayedSummary(characters.slice(0, index).join(""));
      if (index >= characters.length) {
        setSummaryTyping(false);
        return;
      }

      const character = characters[index - 1];
      const delay = /[。！？]/.test(character)
        ? 140
        : /[，；：]/.test(character)
          ? 80
          : character === " "
            ? 12
            : 26;
      timer = setTimeout(typeNextCharacter, delay);
    }

    timer = setTimeout(typeNextCharacter, 180);
    return () => clearTimeout(timer);
  }, [animateSummaryOnMount, projectId, summary, summaryReady]);

  return (
    <section className="dash-summary" aria-label={text("Codex 项目总结", "Codex project summary")}>
      <div className="dash-summary-bubble">
        <p
          className={summaryTyping ? "is-typing" : undefined}
          aria-label={summaryReady ? summary : text("Codex 正在整理项目总结", "Codex is preparing the project summary")}
        >{displayedSummary}</p>
      </div>
      <img className="dash-summary-mark" src="codex-agent-logo.png" alt="" aria-hidden="true" />
    </section>
  );
}

export function DashboardView({
  projectId,
  projectsPanel,
  isAllProjects,
  tasks,
  presentations,
  currentUser,
  animateSummary,
  onSummaryAnimationStart,
  onOpenTask,
  onOpenConversation,
}: DashboardViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [projectSummary, setProjectSummary] = useState<ProjectSummary | null>(null);
  const [summaryLoadFailed, setSummaryLoadFailed] = useState(false);
  useEffect(() => {
    if (isAllProjects) {
      setProjectSummary(null);
      setSummaryLoadFailed(false);
      return undefined;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setProjectSummary(null);
    setSummaryLoadFailed(false);

    async function loadSummary() {
      let delay = 60_000;
      try {
        const next = await getProjectSummary(projectId, controller.signal);
        if (disposed) return;
        setProjectSummary(next);
        setSummaryLoadFailed(false);
        if (next.refreshing) delay = 2_000;
      } catch (error) {
        if (disposed || (error instanceof Error && error.name === "AbortError")) return;
        setSummaryLoadFailed(true);
      }
      if (!disposed) timer = setTimeout(loadSummary, delay);
    }

    void loadSummary();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [isAllProjects, projectId]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayValue = today.getTime();

  const {
    activeTasks, completedTasks, overdueTasks, projectCompletion,
    roleContributions, completedTotal, priorityCounts, labelCounts, totalLabelAssignments,
    visibleLabelCounts, maximumVisibleLabelCount, contributionWeeks, contributionMaximum, contributionTotal,
      contributionDateFormatter, monthMarkers, metrics,
  } = useMemo(() => {
    const upcomingEnd = todayValue + 14 * 86_400_000;
    const activeTasks = tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
    const completedTasks = tasks.filter((task) => task.status === "done");
    const overdueTasks = activeTasks.filter((task) => task.dueDate && dayValue(task.dueDate) < todayValue);
    const upcomingCount = activeTasks
      .filter((task) => task.dueDate && dayValue(task.dueDate) <= upcomingEnd).length;
    const projectCompletion = calculateProjectCompletion(tasks);
    const roleContributionMap = new Map<string, { actor: Task["assignee"]; count: number }>();
    for (const task of tasks) {
      const key = `${task.assignee.type}:${task.assignee.id}`;
      const current = roleContributionMap.get(key);
      roleContributionMap.set(key, {
        actor: task.assignee,
        count: (current?.count ?? 0) + (task.status === "done" ? 1 : 0),
      });
    }
    const roleContributions = [...roleContributionMap.values()]
      .sort((left, right) => right.count - left.count);
    const completedTotal = Math.max(1, completedTasks.length);

    const priorityCounts = PRIORITIES.map((priority) => ({
      priority,
      label: taskPriorityLabel(language, priority),
      count: tasks.filter((task) => task.priority === priority).length,
    }));

    const labelCountMap = new Map<string, number>();
    for (const task of tasks) {
      for (const label of task.labels) {
        labelCountMap.set(label, (labelCountMap.get(label) ?? 0) + 1);
      }
    }
    const labelCounts = [...labelCountMap.entries()]
      .map(([label, count]) => ({
        label,
        count,
        sortName: labelPresentation(label).name,
        presentation: labelPresentation(label, language),
      }))
      .sort((left, right) => (
        right.count - left.count
        || left.sortName.localeCompare(right.sortName)
      ));
    const totalLabelAssignments = Math.max(
      1,
      labelCounts.reduce((total, item) => total + item.count, 0),
    );
    const visibleLabelCounts = (labelCounts.length > 8
      ? [
          ...labelCounts.slice(0, 7),
          {
            label: "__other__",
            count: labelCounts.slice(7).reduce((total, item) => total + item.count, 0),
            presentation: {
              ...labelPresentation("其他"),
              name: text(`其他（${labelCounts.length - 7}个）`, `Other (${labelCounts.length - 7})`),
            },
          },
        ]
      : labelCounts
    ).map((item, index) => ({
      ...item,
      color: item.label === "__other__" ? "var(--dash-other-label)" : LABEL_COLORS[index % LABEL_COLORS.length],
    }));
    const maximumVisibleLabelCount = Math.max(1, ...visibleLabelCounts.map((item) => item.count));

    const activityByDay = new Map<string, number>();
    for (const task of tasks) {
      const key = dateKey(new Date(task.activityUpdatedAt));
      activityByDay.set(key, (activityByDay.get(key) ?? 0) + 1);
    }
    const contributionStart = new Date(todayValue);
    contributionStart.setDate(contributionStart.getDate() - contributionStart.getDay() - 51 * 7);
    const contributionWeeks = Array.from({ length: 52 }, (_, weekIndex) => (
      Array.from({ length: 7 }, (_, dayIndex) => {
        const date = new Date(contributionStart);
        date.setDate(date.getDate() + weekIndex * 7 + dayIndex);
        const key = dateKey(date);
        return {
          date,
          key,
          count: activityByDay.get(key) ?? 0,
          future: date.getTime() > todayValue,
        };
      })
    ));
    const contributionMaximum = Math.max(1, ...contributionWeeks.flat().map((day) => day.count));
    const contributionTotal = contributionWeeks.reduce((sum, week) => sum + week.reduce((daySum, day) => daySum + day.count, 0), 0);
    const monthFormatter = new Intl.DateTimeFormat(locale, { month: "short" });
    const contributionDateFormatter = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const monthMarkers = contributionWeeks.flatMap((week, weekIndex) => {
      const firstDay = week.find((day) => day.date.getDate() === 1);
      return firstDay ? [{ weekIndex, label: monthFormatter.format(firstDay.date) }] : [];
    });
    if (monthMarkers[0]?.weekIndex !== 0) {
      monthMarkers.unshift({ weekIndex: 0, label: monthFormatter.format(contributionStart) });
    }

    const metrics = [
      {
        label: taskStatusLabel(language, "in_progress"),
        value: tasks.filter((task) => task.status === "in_progress").length,
        tone: "progress",
      },
      {
        label: text("待办", "To do"),
        value: tasks.filter((task) => task.status === "todo").length,
        tone: "todo",
      },
      {
        label: taskStatusLabel(language, "in_review"),
        value: tasks.filter((task) => task.status === "in_review").length,
        tone: "review",
      },
      {
        label: taskStatusLabel(language, "blocked"),
        value: tasks.filter((task) => task.status === "blocked").length,
        tone: "blocked",
      },
      { label: text("已逾期", "Overdue"), value: overdueTasks.length, tone: "overdue" },
      {
        label: text("两周内到期", "Due in 2 weeks"),
        value: upcomingCount,
        tone: "due",
      },
    ];

    return {
      activeTasks, completedTasks, overdueTasks, projectCompletion,
      roleContributions, completedTotal, priorityCounts, labelCounts, totalLabelAssignments,
      visibleLabelCounts, maximumVisibleLabelCount, contributionWeeks, contributionMaximum, contributionTotal,
      contributionDateFormatter, monthMarkers, metrics,
    };
  }, [language, locale, tasks, text, todayValue]);

  const runningTasks = useMemo(() => tasks.filter(
    (task) => presentations[task.id]?.processing.running,
  ), [presentations, tasks]);

  const summaryBody = isAllProjects
    ? text(
        `所有项目共有 ${tasks.length} 个议题，${completedTasks.length} 个已完成，${activeTasks.length} 个尚未结束；当前 ${tasks.filter((task) => task.status === "blocked").length} 个遇到阻碍，${overdueTasks.length} 个已逾期。`,
        `Across all projects, ${tasks.length} issues are tracked: ${completedTasks.length} completed and ${activeTasks.length} still open; ${tasks.filter((task) => task.status === "blocked").length} are blocked and ${overdueTasks.length} overdue.`,
      )
    : projectSummary?.summary
      ?? (projectSummary?.refreshing
        ? text(
            "Codex 正在整理当前项目的进展、风险和下一步重点…",
            "Codex is reviewing the project's progress, risks, and next steps…",
          )
        : summaryLoadFailed || projectSummary?.error
          ? text("Codex 暂时无法生成项目总结。", "Codex cannot generate the project summary now.")
          : text(
              "Codex 正在整理当前项目的进展、风险和下一步重点…",
              "Codex is reviewing the project's progress, risks, and next steps…",
            ));
  const hour = new Date().getHours();
  const greeting = hour < 12
    ? text("上午好", "Good morning")
    : hour < 18
      ? text("下午好", "Good afternoon")
      : text("晚上好", "Good evening");
  const summaryDate = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(today);
  const summary = text(
    `${greeting}，${currentUser.name}，今天是${summaryDate}，${summaryBody}`,
    `${greeting}, ${currentUser.name}. Today is ${summaryDate}. ${summaryBody}`,
  );
  const summaryReady = isAllProjects || projectSummary !== null || summaryLoadFailed;

  return (
    <div className="dashboard-view">
      <div className="dash-root">
        <section className="dash-hero">
        <div className="dash-hero-copy">
          <span className="dash-hero-label">{text("项目完成度", "Project completion")}</span>
          <div className="dash-hero-figure">
            <strong className="dash-hero-num">{projectCompletion.percentage}<i>%</i></strong>
            <ul className="dash-hero-stats">
              <li>
                <b>{projectCompletion.parentCount > 0
                  ? `${projectCompletion.completedParents}/${projectCompletion.parentCount}`
                  : "—"}</b>
                <span>{text("顶层议题完成", "Top-level done")}</span>
              </li>
              <li>
                <b>{tasks.length}</b>
                <span>{text("议题总数", "Issues")}</span>
              </li>
              <li>
                <b>{completedTasks.length}</b>
                <span>{text("已完成", "Completed")}</span>
              </li>
              <li>
                <b>{activeTasks.length}</b>
                <span>{text("未结束", "Open")}</span>
              </li>
            </ul>
          </div>
        </div>
        <DashboardSummary
            projectId={projectId}
            summary={summary}
            summaryReady={summaryReady}
            animateSummary={animateSummary}
            onSummaryAnimationStart={onSummaryAnimationStart}
          />
      </section>

      <div className="dash-strip" role="list" aria-label={text("议题状态", "Issue status")}>
        {metrics.map((metric) => {
          return (
            <div className={`dash-strip-cell tone-${metric.tone}${metric.value === 0 ? " is-zero" : ""}`} key={metric.label} role="listitem">
              <span className="dash-strip-name">{metric.label}</span>
              <span className="dash-strip-value">
                <strong>{metric.value}</strong>
              </span>
            </div>
          );
        })}
      </div>

      {projectsPanel ? (
        <div className="dash-projects-panel">
          {projectsPanel}
        </div>
      ) : null}

      <div className="dash-grid">
        <section className="dash-card dash-contribution-card">
              <header><span>{text("贡献图", "Contribution chart")}</span></header>
              {contributionTotal ? (
              <div className="dash-contrib">
                <div className="dash-contrib-days" aria-hidden="true">
                  <span style={{ gridRow: 2 }}>{text("一", "M")}</span>
                  <span style={{ gridRow: 4 }}>{text("三", "W")}</span>
                  <span style={{ gridRow: 6 }}>{text("五", "F")}</span>
                </div>
                <div className="dash-contrib-months" aria-hidden="true">
                  {monthMarkers.map((marker) => (
                    <span
                      style={{ gridColumn: marker.weekIndex + 1 }}
                      key={`${marker.weekIndex}-${marker.label}`}
                    >
                      {marker.label}
                    </span>
                  ))}
                </div>
                <div className="dash-contrib-grid" aria-label={text("过去一年议题贡献图", "Issue contributions over the past year")}>
                  {contributionWeeks.flat().map((day) => {
                    const level = day.count === 0
                      ? 0
                      : Math.min(4, Math.ceil((day.count / contributionMaximum) * 4));
                    return (
                      <span
                        className={`dash-contrib-cell level-${level}${day.future ? " is-future" : ""}`}
                        title={day.future ? undefined : text(
                          `${contributionDateFormatter.format(day.date)} · ${day.count} 个议题更新`,
                          `${contributionDateFormatter.format(day.date)} · ${day.count} issue ${day.count === 1 ? "update" : "updates"}`,
                        )}
                        key={day.key}
                      />
                    );
                  })}
                </div>
                <div className="dash-contrib-legend" aria-label={text("贡献强度图例", "Contribution intensity legend")}>
                  <span>{text("少", "Less")}</span>
                  {[0, 1, 2, 3, 4].map((level) => (
                    <i className={`dash-contrib-cell level-${level}`} key={level} />
                  ))}
                  <span>{text("多", "More")}</span>
                </div>
              </div>
              ) : (
                <div className="dash-empty">{text("完成议题后这里会出现一年内的更新记录", "Completed issues will appear here over the past year")}</div>
              )}
            </section>

        <div className="dash-side">
          {runningTasks.length ? (
            <section className="dash-card dash-stack-card">
                <header><span>{text("运行中对话", "Active conversations")}</span><b>{runningTasks.length}</b></header>
                <div className="dash-task-list">
                  {runningTasks.map((task) => (
                    <article
                      className="dash-task-row is-clickable"
                      key={task.id}
                      onClick={() => onOpenTask(task)}
                    >
                      <span className="dash-task-mark" aria-hidden="true">
                        <img className="dash-task-spinner" src={processingAnimation} alt="" aria-hidden="true" />
                      </span>
                      <strong>{task.title}</strong>
                      <small>{task.externalKey ?? task.identifier}</small>
                      <TaskConversationMenu
                        conversations={presentations[task.id].conversations}
                        onOpenConversation={onOpenConversation}
                      />
                    </article>
                  ))}
                </div>
              </section>
          ) : null}
          <section className="dash-card dash-stack-card">
              <header><span>{text("角色贡献", "Role contributions")}</span><b>{roleContributions.length}</b></header>
              {roleContributions.length ? (
                <div className="dash-role-list">
                  {roleContributions.map((item, index) => (
                    <div className="dash-role-row" key={`${item.actor.type}:${item.actor.id}`}>
                      <ActorAvatar actor={actorKey(item.actor) === actorKey(currentUser) ? currentUser : item.actor} />
                      <span className="dash-role-copy">
                        <strong>{item.actor.name}</strong>
                        <small>{text(
                          `${item.count} 个已完成议题`,
                          `${item.count} completed ${item.count === 1 ? "issue" : "issues"}`,
                        )}</small>
                      </span>
                      <span className={`dash-role-share tone-${index % 5}`}>
                        {Math.round((item.count / completedTotal) * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="dash-empty">{text("完成议题后这里会出现成员贡献", "Member contributions appear here")}</div>
              )}
            </section>
        </div>

        <section className="dash-card dash-split-card">
              <div className="dash-split-half">
                <header><span>{text("优先级", "Priority")}</span></header>
                <div className="dash-priority-list">
                  {priorityCounts.map((item) => (
                    <div className={`dash-priority-row priority-${item.priority}`} key={item.priority}>
                      <span className="dash-priority-name">
                        <PriorityIcon priority={item.priority} size={13} />
                        {item.label}
                      </span>
                      <span className="dash-priority-track">
                        <i style={{ width: `${tasks.length ? (item.count / tasks.length) * 100 : 0}%` }} />
                      </span>
                      <strong>{item.count}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="dash-split-divider" aria-hidden="true" />
              <div className="dash-split-half">
                <header><span>{text("标签分布", "Label distribution")}</span></header>
                {visibleLabelCounts.length ? (
                  <div className="dash-label-list">
                    {visibleLabelCounts.map((item) => (
                      <div className="dash-label-row" key={item.label}>
                        <strong>{item.presentation.name}</strong>
                        <span className="dash-label-meter" aria-hidden="true">
                          <i style={{ width: `${(item.count / maximumVisibleLabelCount) * 100}%`, background: item.color }} />
                        </span>
                        <b>{item.count}</b>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="dash-empty">{text("给议题打上标签后这里会显示分布", "Label distribution appears here")}</div>
                )}
              </div>
            </section>
        </div>
      </div>
    </div>
  );
}
