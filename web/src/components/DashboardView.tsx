import { useEffect, useMemo, useRef, useState } from "react";

import "./DashboardView.css";
import dueDoneIcon from "../assets/figma-taskboard/dashboard-due-done.svg";
import dueEditIcon from "../assets/figma-taskboard/dashboard-due-edit.svg";
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
  projectCreatedAt: string | null;
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

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const STARTED_STATUSES = new Set<Task["status"]>([
  "in_progress",
  "in_review",
  "blocked",
]);

interface ProgressPoint {
  timestamp: number;
  scope: number;
  started: number;
  completed: number;
  completions: number;
}

interface ProgressForecast {
  optimisticAt: number;
  conservativeAt: number;
}

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

function chartDate(value: number, locale: string, referenceValue?: number) {
  const includeYear = referenceValue !== undefined
    && new Date(value).getFullYear() !== new Date(referenceValue).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    year: includeYear ? "numeric" : undefined,
    month: "short",
    day: "numeric",
  }).format(value);
}

function taskStartValue(task: Task) {
  const createdAt = new Date(task.createdAt).getTime();
  if (task.startDate) return Math.max(createdAt, dayValue(task.startDate));
  if (task.status === "done") return createdAt;
  return Math.max(createdAt, new Date(task.updatedAt).getTime());
}

function buildProgressData(tasks: Task[], todayValue: number, projectCreatedAt: string | null) {
  const scopeTasks = tasks.filter((task) => task.status !== "canceled");
  const completedTasks = scopeTasks.filter((task) => task.status === "done");
  const activeStartedTasks = scopeTasks.filter((task) => STARTED_STATUSES.has(task.status));
  const startedTasks = scopeTasks.filter((task) => (
    task.status === "done" || STARTED_STATUSES.has(task.status)
  ));
  const projectStart = projectCreatedAt
    ? new Date(projectCreatedAt).getTime()
    : todayValue;
  const historyStart = Math.min(projectStart, todayValue);
  const interval = (todayValue - historyStart) / 12;
  const points = Array.from({ length: 13 }, (_, index): ProgressPoint => {
    const timestamp = index === 12 ? todayValue : historyStart + interval * index;
    const previousTimestamp = index === 0 ? historyStart - 1 : historyStart + interval * (index - 1);
    return {
      timestamp,
      scope: scopeTasks.filter((task) => new Date(task.createdAt).getTime() <= timestamp).length,
      started: startedTasks.filter((task) => taskStartValue(task) <= timestamp).length,
      completed: completedTasks.filter((task) => new Date(task.updatedAt).getTime() <= timestamp).length,
      completions: completedTasks.filter((task) => {
        const completedAt = new Date(task.updatedAt).getTime();
        return completedAt > previousTimestamp && completedAt <= timestamp;
      }).length,
    };
  });

  points[points.length - 1] = {
    ...points[points.length - 1],
    scope: scopeTasks.length,
    started: startedTasks.length,
    completed: completedTasks.length,
  };

  const remaining = scopeTasks.length - completedTasks.length;
  const recentStart = Math.max(historyStart, todayValue - 28 * DAY_MS);
  const recentCompletions = completedTasks.filter((task) => (
    new Date(task.updatedAt).getTime() >= recentStart
  )).length;
  const recentWeeks = Math.max(1, (todayValue - recentStart) / WEEK_MS);
  const elapsedWeeks = Math.max(1, (todayValue - historyStart) / WEEK_MS);
  const weeklyVelocity = recentCompletions > 0
    ? recentCompletions / recentWeeks
    : completedTasks.length / elapsedWeeks;
  const forecast = remaining > 0 && weeklyVelocity > 0
    ? {
        optimisticAt: todayValue + (remaining / (weeklyVelocity * 1.4)) * WEEK_MS,
        conservativeAt: todayValue + (remaining / (weeklyVelocity * .6)) * WEEK_MS,
      }
    : null;

  return {
    scope: scopeTasks.length,
    started: activeStartedTasks.length,
    completed: completedTasks.length,
    unstarted: Math.max(0, scopeTasks.length - startedTasks.length),
    points,
    forecast,
  } satisfies {
    scope: number;
    started: number;
    completed: number;
    unstarted: number;
    points: ProgressPoint[];
    forecast: ProgressForecast | null;
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

function smoothPath(points: { x: number; y: number }[]) {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`;
  }
  let d = `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function shortDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
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

function DashboardProgressChart({ progressData, todayValue }: {
  progressData: ReturnType<typeof buildProgressData>;
  todayValue: number;
}) {
  const { locale, text } = useTaskboardI18n();
  const [progressHoverIndex, setProgressHoverIndex] = useState<number | null>(null);
  const progressChart = useMemo(() => {
    const bars = progressData.points.map((point, index, points) => {
      const step = 100 / points.length;
      return {
        ...point,
        x: index * step + step * 0.16,
        width: step * 0.68,
        previousCompleted: index === 0 ? 0 : points[index - 1].completed,
      };
    });
    const valueMaximum = Math.max(4, progressData.scope);
    return { bars, valueMaximum };
  }, [progressData]);
  const hoveredProgressPoint = progressHoverIndex === null
    ? null
    : progressChart.bars[progressHoverIndex];
  const percent = progressData.scope > 0
    ? Math.round((progressData.completed / progressData.scope) * 100)
    : null;

  return (
    <section className="dash-card dash-progress-card">
      <header className="dash-chart-head">
        <div className="dash-chart-title">
          <span>{text("累计进度", "Cumulative progress")}</span>
          <small className="dash-chart-meta">{percent === null ? text("暂无任务", "No tasks") : percent + "% · " + progressData.completed + "/" + progressData.scope}</small>
        </div>
        <div className="dash-chart-legend">
          <span className="tone-completed"><i />{text("分期完成", "Interval completions")}</span>
          <span className="tone-scope"><i />{text("当前累计", "Current total")} <strong>{progressData.completed}</strong></span>
        </div>
      </header>
      <div className="dash-chart-body">
        <svg
          className="dash-chart-svg"
          viewBox="0 0 100 116"
          preserveAspectRatio="none"
          role="img"
          aria-label={text(
            "分期完成任务量，当前累计 " + progressData.completed + "，总范围 " + progressData.scope,
            "Completed tasks per interval, current total " + progressData.completed + ", total scope " + progressData.scope,
          )}
        >
          <defs>
            <linearGradient id="dash-progress-bar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#0071e3" stopOpacity=".34" />
              <stop offset="1" stopColor="#0071e3" stopOpacity=".08" />
            </linearGradient>
          </defs>
          {progressChart.bars.map((bar, index) => {
            const growth = bar.completed - bar.previousCompleted;
            const barHeight = growth > 0
              ? Math.min(100, Math.max(4, (growth / progressChart.valueMaximum) * 260))
              : 0;
            const isLatest = index === progressChart.bars.length - 1;
            return (
              <rect
                className="dash-progress-bar"
                x={bar.x}
                y={100 - barHeight}
                width={bar.width}
                height={barHeight}
                rx={isLatest ? 1.4 : 1.2}
                opacity={isLatest ? 1 : 0.78}
                key={bar.timestamp}
              />
            );
          })}
          <line className="dash-chart-baseline" x1="0" y1="100" x2="100" y2="100" vectorEffect="non-scaling-stroke" />
          {progressData.forecast ? (
            <g className="dash-progress-forecast">
              <circle cx="97.4" cy="20" r="1.7" />
              <text className="dash-progress-forecast-label" x="93.4" y="21.2" textAnchor="end">
                {chartDate(progressData.forecast.optimisticAt, locale)}
              </text>
            </g>
          ) : null}
          {hoveredProgressPoint ? (
            <>
              <line
                className="dash-chart-hover"
                x1={hoveredProgressPoint.x + hoveredProgressPoint.width / 2}
                y1="8"
                x2={hoveredProgressPoint.x + hoveredProgressPoint.width / 2}
                y2="100"
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : null}
          {progressChart.bars.map((bar, index) => (
            <rect
              className="dash-chart-hit"
              x={(index * 100) / progressChart.bars.length}
              y="0"
              width={100 / progressChart.bars.length}
              height="104"
              fill="transparent"
              role="button"
              tabIndex={0}
              aria-label={text(
                chartDate(bar.timestamp, locale) + "：累计 " + bar.completed + "，新增 " + (bar.completed - bar.previousCompleted),
                chartDate(bar.timestamp, locale) + ": total " + bar.completed + ", new " + (bar.completed - bar.previousCompleted),
              )}
              onMouseEnter={() => setProgressHoverIndex(index)}
              onMouseLeave={() => setProgressHoverIndex(null)}
              onFocus={() => setProgressHoverIndex(index)}
              onBlur={() => setProgressHoverIndex(null)}
              onClick={() => setProgressHoverIndex(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setProgressHoverIndex(index);
              }}
              key={bar.timestamp + "-" + index}
            />
          ))}
        </svg>
        {hoveredProgressPoint ? (
          <div
            className="dash-progress-tip"
            style={{
              left: `clamp(44px, ${(hoveredProgressPoint.x + hoveredProgressPoint.width / 2)}%, calc(100% - 44px))`,
            }}
          >
            <strong>{progressData.completed}</strong>
            <span>{chartDate(hoveredProgressPoint.timestamp, locale)}</span>
            <em>{text("新增", "New")} +{hoveredProgressPoint.completed - hoveredProgressPoint.previousCompleted}</em>
          </div>
        ) : null}
        <div className="dash-progress-axis">
          <span>{chartDate(progressData.points[0].timestamp, locale)}</span>
          <span className="is-current">{chartDate(todayValue, locale)}</span>
        </div>
      </div>
    </section>
  );
}

export function DashboardView({
  projectId,
  projectCreatedAt,
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
    activeTasks, completedTasks, overdueTasks, upcomingTasks, projectCompletion,
    roleContributions, completedTotal, priorityCounts, labelCounts, totalLabelAssignments,
    visibleLabelCounts, maximumVisibleLabelCount, contributionWeeks, contributionMaximum, contributionTotal,
      contributionDateFormatter, monthMarkers, metrics,
  } = useMemo(() => {
    const upcomingEnd = todayValue + 14 * 86_400_000;
    const activeTasks = tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
    const completedTasks = tasks.filter((task) => task.status === "done");
    const overdueTasks = activeTasks.filter((task) => task.dueDate && dayValue(task.dueDate) < todayValue);
    const upcomingTasks = activeTasks
      .filter((task) => task.dueDate && dayValue(task.dueDate) <= upcomingEnd)
      .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? ""))
      .slice(0, 5);
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
    const visibleLabelCounts = (labelCounts.length > 12
      ? [
          ...labelCounts.slice(0, 11),
          {
            label: "__other__",
            count: labelCounts.slice(11).reduce((total, item) => total + item.count, 0),
            presentation: {
              ...labelPresentation("其他"),
              name: text(`其他（${labelCounts.length - 11}个）`, `Other (${labelCounts.length - 11})`),
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
        label: taskStatusLabel(language, "backlog"),
        value: tasks.filter((task) => task.status === "backlog").length,
        tone: "backlog",
      },
    ];

    return {
      activeTasks, completedTasks, overdueTasks, upcomingTasks, projectCompletion,
      roleContributions, completedTotal, priorityCounts, labelCounts, totalLabelAssignments,
      visibleLabelCounts, maximumVisibleLabelCount, contributionWeeks, contributionMaximum, contributionTotal,
      contributionDateFormatter, monthMarkers, metrics,
    };
  }, [language, locale, tasks, text, todayValue]);

  const progressData = useMemo(() => {
    const aggregateCreatedAt = isAllProjects
      ? tasks.reduce<string | null>((earliest, task) => (
          !earliest || task.createdAt < earliest ? task.createdAt : earliest
        ), null)
      : null;
    return buildProgressData(
      tasks,
      todayValue,
      projectCreatedAt ?? aggregateCreatedAt,
    );
  }, [isAllProjects, projectCreatedAt, tasks, todayValue]);

  const runningTasks = useMemo(() => tasks.filter(
    (task) => presentations[task.id]?.processing.running,
  ), [presentations, tasks]);

  const attentionItems = useMemo(() => activeTasks
    .filter((task) => task.status === "blocked" || presentations[task.id]?.unread)
    .sort((left, right) => {
      const leftUnread = presentations[left.id]?.unread ? 1 : 0;
      const rightUnread = presentations[right.id]?.unread ? 1 : 0;
      return rightUnread - leftUnread
        || right.activityUpdatedAt.localeCompare(left.activityUpdatedAt);
    })
    .slice(0, 5), [activeTasks, presentations]);

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
          <strong className="dash-hero-num">{projectCompletion.percentage}<i>%</i></strong>
          <p>{text(
            projectCompletion.parentCount > 0
              ? `${summaryDate} · ${projectCompletion.completedParents}/${projectCompletion.parentCount} 个顶层议题完成 · ${completedTasks.length} 个议题已完成`
              : `${summaryDate} · 暂无可计算的议题`,
            projectCompletion.parentCount > 0
              ? `${summaryDate} · ${projectCompletion.completedParents}/${projectCompletion.parentCount} top-level issues complete · ${completedTasks.length} issues complete`
              : `${summaryDate} · No issues to calculate`,
          )}</p>
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
          const percent = activeTasks.length ? Math.round((metric.value / activeTasks.length) * 100) : 0;
          return (
            <div className={`dash-strip-cell tone-${metric.tone}${metric.value === 0 ? " is-zero" : ""}`} key={metric.label} role="listitem">
              <span className="dash-strip-name">{metric.label}</span>
              <span className="dash-strip-value">
                <strong>{metric.value}</strong>
                {metric.value > 0 && <small>{percent}%</small>}
              </span>
              <span className="dash-strip-track" aria-hidden="true">
                <i style={{ width: `${percent}%` }} />
              </span>
            </div>
          );
        })}
      </div>

      <div className="dash-grid">
        <DashboardProgressChart progressData={progressData} todayValue={todayValue} />

        <div className="dash-side">
          <section className="dash-card dash-stack-card">
              <header><span>{text("需要关注", "Needs attention")}</span><b>{attentionItems.length}</b></header>
              <div className="dash-task-list">
                {attentionItems.length ? attentionItems.map((task) => (
                  <button
                    type="button"
                    className="dash-task-row"
                    onClick={() => onOpenTask(task)}
                    key={task.id}
                  >
                    <span className="dash-task-mark" aria-hidden="true">
                      {presentations[task.id]?.unread && <i />}
                    </span>
                    <strong>{task.title}</strong>
                    <small>{task.externalKey ?? task.identifier}</small>
                  </button>
                )) : (
                  <div className="dash-empty">{text("都已处理完毕", "All caught up")}</div>
                )}
              </div>
            </section>
          <section className="dash-card dash-stack-card">
              <header><span>{text("即将到期", "Due soon")}</span><b>{upcomingTasks.length}</b></header>
              <div className="dash-task-list">
                {upcomingTasks.length ? upcomingTasks.map((task) => (
                  <button
                    type="button"
                    className="dash-task-row"
                    onClick={() => onOpenTask(task)}
                    key={task.id}
                  >
                    <span className="dash-task-mark" aria-hidden="true">
                      <img src={task.status === "in_review" ? dueDoneIcon : dueEditIcon} alt="" aria-hidden="true" />
                    </span>
                    <strong>{task.title}</strong>
                    <small>{shortDate(task.dueDate!, locale)}</small>
                  </button>
                )) : (
                  <div className="dash-empty">{text("没有临近的截止日期", "Nothing due soon")}</div>
                )}
              </div>
            </section>
        </div>

        <section className="dash-card dash-contribution-card">
              <header><span>{text("贡献图", "Contribution chart")}</span></header>
              {contributionTotal ? (
              <div className="dash-contrib">
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
                <div className="dash-contrib-main">
                  <div className="dash-contrib-days" aria-hidden="true">
                    <span style={{ gridRow: 2 }}>{text("一", "M")}</span>
                    <span style={{ gridRow: 4 }}>{text("三", "W")}</span>
                    <span style={{ gridRow: 6 }}>{text("五", "F")}</span>
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
          <section className="dash-card dash-stack-card">
              <header><span>{text("运行中对话", "Active conversations")}</span><b>{runningTasks.length}</b></header>
              <div className="dash-task-list">
                {runningTasks.length ? runningTasks.map((task) => (
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
                )) : (
                  <div className="dash-empty">{text("打开任一议题即可开始对话", "Open an issue to start a conversation")}</div>
                )}
              </div>
            </section>
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
