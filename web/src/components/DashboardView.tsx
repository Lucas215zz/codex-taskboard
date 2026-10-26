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
    <div className="dash-brief" aria-label={text("Codex 项目总结", "Codex project summary")}>
      <img className="dash-brief-mark" src="codex-agent-logo.png" alt="" aria-hidden="true" />
      <p
        className={summaryTyping ? "is-typing" : undefined}
        aria-label={summaryReady ? summary : text("Codex 正在整理项目总结", "Codex is preparing the project summary")}
      >{displayedSummary}</p>
    </div>
  );
}

function DashboardProgressChart({ progressData, todayValue }: {
  progressData: ReturnType<typeof buildProgressData>;
  todayValue: number;
}) {
  const { locale, text } = useTaskboardI18n();
  const [progressHoverIndex, setProgressHoverIndex] = useState<number | null>(null);
  // History always keeps 78% of the width; the rest is a forecast window of at
  // least two weeks so the axis stays legible for short-lived projects.
  const forecastSpan = Math.max(
    14 * DAY_MS,
    progressData.forecast
      ? Math.max(progressData.forecast.conservativeAt, progressData.forecast.optimisticAt) - todayValue
      : 0,
  );
  const rangeEndValue = todayValue + forecastSpan;
  const progressChart = useMemo(() => {
    const left = 0;
    const right = 640;
    const top = 28;
    const bottom = 236;
    const historyStartValue = progressData.points[0].timestamp;
    const historyRange = Math.max(DAY_MS, todayValue - historyStartValue);
    const currentX = left + (right - left) * 0.78;
    const x = (value: number) => (value <= todayValue
      ? left + (currentX - left) * ((value - historyStartValue) / historyRange)
      : currentX + (right - currentX) * ((value - todayValue) / forecastSpan));
    const valueMaximum = Math.max(1, progressData.scope);
    const y = (value: number) => bottom - (value / valueMaximum) * (bottom - top);
    const points = progressData.points.map((point) => ({
      ...point,
      x: x(point.timestamp),
    }));
    const path = (key: "scope" | "completed") => points
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${y(point[key]).toFixed(2)}`)
      .join(" ");
    const completedPath = path("completed");
    const forecast = progressData.forecast
      ? {
          optimisticX: x(progressData.forecast.optimisticAt),
          conservativeX: x(progressData.forecast.conservativeAt),
        }
      : null;
    return {
      left,
      right,
      top,
      bottom,
      currentX,
      y,
      points,
      scopePath: `${path("scope")} L${right} ${y(progressData.scope).toFixed(2)}`,
      completedPath,
      completedArea: `${completedPath} L${currentX} ${bottom} L${left} ${bottom} Z`,
      forecast,
      maximumCompletions: Math.max(1, ...progressData.points.map((point) => point.completions)),
    };
  }, [forecastSpan, progressData, todayValue]);
  const hoveredProgressPoint = progressHoverIndex === null
    ? null
    : progressChart.points[progressHoverIndex];

  return (
    <div className="dash-chart">
      <div className="dashboard-progress-body">
        <svg
          className="dashboard-progress-chart"
          viewBox="0 0 640 272"
          role="img"
          aria-label={text(
            `项目累计进度：范围 ${progressData.scope}，已完成 ${progressData.completed}，待完成 ${progressData.scope - progressData.completed}`,
            `Cumulative project progress: scope ${progressData.scope}, completed ${progressData.completed}, remaining ${progressData.scope - progressData.completed}`,
          )}
        >
          <defs>
            <linearGradient id="dashboard-progress-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#22b889" stopOpacity=".18" />
              <stop offset="1" stopColor="#22b889" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="dashboard-progress-forecast-area" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#22b889" stopOpacity=".11" />
              <stop offset="1" stopColor="#22b889" stopOpacity=".025" />
            </linearGradient>
          </defs>

          <line
            className="dashboard-progress-baseline"
            x1={progressChart.left}
            y1={progressChart.bottom}
            x2={progressChart.right}
            y2={progressChart.bottom}
          />
          <path className="dashboard-progress-completed-area" d={progressChart.completedArea} />
          {progressChart.forecast ? (
            <path
              className="dashboard-progress-forecast-area"
              d={`M${progressChart.currentX} ${progressChart.y(progressData.completed)} L${progressChart.forecast.optimisticX} ${progressChart.y(progressData.scope)} L${progressChart.forecast.conservativeX} ${progressChart.y(progressData.scope)} Z`}
            />
          ) : null}
          <path className="dashboard-progress-line tone-scope" d={progressChart.scopePath} />
          <path className="dashboard-progress-line tone-completed" d={progressChart.completedPath} />
          {progressChart.forecast ? (
            <>
              <path
                className="dashboard-progress-projection"
                d={`M${progressChart.currentX} ${progressChart.y(progressData.completed)} L${progressChart.forecast.optimisticX} ${progressChart.y(progressData.scope)}`}
              />
              <path
                className="dashboard-progress-projection"
                d={`M${progressChart.currentX} ${progressChart.y(progressData.completed)} L${progressChart.forecast.conservativeX} ${progressChart.y(progressData.scope)}`}
              />
            </>
          ) : null}

          {progressChart.points.slice(1).map((point, index) => {
            if (!point.completions) return null;
            const width = 4;
            const height = 8 + (point.completions / progressChart.maximumCompletions) * 20;
            return (
              <rect
                className="dashboard-progress-delivery-bar"
                x={point.x - width / 2}
                y={progressChart.bottom - height}
                width={width}
                height={height}
                rx="2"
                key={`${point.timestamp}-${index}`}
              />
            );
          })}

          <line
            className="dashboard-progress-now-line"
            x1={progressChart.currentX}
            y1={progressChart.top - 4}
            x2={progressChart.currentX}
            y2={progressChart.bottom + 7}
          />
          <circle className="dashboard-progress-point tone-scope" cx={progressChart.currentX} cy={progressChart.y(progressData.scope)} r="4" />
          <circle className="dashboard-progress-point tone-completed" cx={progressChart.currentX} cy={progressChart.y(progressData.completed)} r="4" />

          {hoveredProgressPoint ? (
            <>
              <line
                className="dashboard-progress-hover-line"
                x1={hoveredProgressPoint.x}
                y1={progressChart.top - 2}
                x2={hoveredProgressPoint.x}
                y2={progressChart.bottom + 5}
              />
              <g
                className="dashboard-progress-tooltip"
                transform={`translate(${hoveredProgressPoint.x > progressChart.right - 172 ? hoveredProgressPoint.x - 172 : hoveredProgressPoint.x + 10} 8)`}
              >
                <rect width="162" height="80" rx="9" />
                <text className="dashboard-progress-tooltip-date" x="12" y="20">
                  {chartDate(hoveredProgressPoint.timestamp, locale)}
                </text>
                <text x="12" y="40">{text("范围", "Scope")} {hoveredProgressPoint.scope}</text>
                <text x="12" y="58">{text("未完成", "Remaining")} {Math.max(0, hoveredProgressPoint.scope - hoveredProgressPoint.completed)}</text>
                <text x="88" y="58">{text("已完成", "Completed")} {hoveredProgressPoint.completed}</text>
                <text className="dashboard-progress-tooltip-delta" x="88" y="40">
                  Δ {hoveredProgressPoint.scope - (progressChart.points[Math.max(0, progressHoverIndex! - 1)]?.scope ?? hoveredProgressPoint.scope)}
                </text>
              </g>
            </>
          ) : null}

          {progressChart.points.map((point, index) => {
            const hitWidth = (progressChart.currentX - progressChart.left) / (progressChart.points.length - 1);
            return (
              <rect
                className="dashboard-progress-hitbox"
                x={Math.max(progressChart.left, point.x - hitWidth / 2)}
                y={progressChart.top - 6}
                width={index === 0 || index === progressChart.points.length - 1 ? hitWidth / 2 : hitWidth}
                height={progressChart.bottom - progressChart.top + 16}
                fill="transparent"
                role="button"
                tabIndex={0}
                aria-label={text(
                  `${chartDate(point.timestamp, locale)}：范围 ${point.scope}，已完成 ${point.completed}，未完成 ${Math.max(0, point.scope - point.completed)}`,
                  `${chartDate(point.timestamp, locale)}: scope ${point.scope}, completed ${point.completed}, remaining ${Math.max(0, point.scope - point.completed)}`,
                )}
                onMouseEnter={() => setProgressHoverIndex(index)}
                onMouseLeave={() => setProgressHoverIndex(null)}
                onFocus={() => setProgressHoverIndex(index)}
                onBlur={() => setProgressHoverIndex(null)}
                onClick={() => setProgressHoverIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setProgressHoverIndex(index);
                }}
                key={`${point.timestamp}-${index}`}
              />
            );
          })}

          <text className="dashboard-progress-axis-label" x={progressChart.left} y="260">
            {chartDate(progressChart.points[0].timestamp, locale)}
          </text>
          <text className="dashboard-progress-axis-label is-current" x={progressChart.currentX} y="260" textAnchor="middle">
            {chartDate(todayValue, locale)}
          </text>
          <text className="dashboard-progress-axis-label" x={progressChart.right} y="260" textAnchor="end">
            {chartDate(rangeEndValue, locale, todayValue)}
          </text>
        </svg>
      </div>
      <dl className="dash-chart-stats">
        <div className="tone-scope">
          <dt>{text("范围", "Scope")}</dt>
          <dd>{progressData.scope}</dd>
        </div>
        <div className="tone-completed">
          <dt>{text("已完成", "Completed")}</dt>
          <dd>{progressData.completed}</dd>
        </div>
        <div className="tone-left">
          <dt>{text("未完成", "Remaining")}</dt>
          <dd>{Math.max(0, progressData.scope - progressData.completed)}</dd>
        </div>
        <div className="tone-rate">
          <dt>{text("完成率", "Done rate")}</dt>
          <dd>{progressData.scope ? Math.round((progressData.completed / progressData.scope) * 100) : 0}<i>%</i></dd>
        </div>
      </dl>
    </div>
  );
}
const STALL_DAYS = 7;

function dayGap(fromIso: string, nowValue: number) {
  return Math.max(0, Math.floor((nowValue - new Date(fromIso).getTime()) / DAY_MS));
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
  const nowValue = Date.now();

  const {
    scopedTasks, activeTasks, completedTasks, projectCompletion,
    reviewTasks, blockedTasks, stalledTasks, staleQueue, weekDone, prevWeekDone,
    labelCounts, totalLabelAssignments, labeledTaskCount,
    unlabeledTaskCount, scopedTaskCount, visibleLabelCounts,
  } = useMemo(() => {
    const scopedTasks = tasks.filter((task) => task.status !== "canceled");
    const activeTasks = scopedTasks.filter((task) => task.status !== "done");
    const completedTasks = scopedTasks.filter((task) => task.status === "done");
    const projectCompletion = calculateProjectCompletion(tasks);

    const reviewTasks = scopedTasks
      .filter((task) => task.status === "in_review")
      .sort((left, right) => left.activityUpdatedAt.localeCompare(right.activityUpdatedAt));
    const blockedTasks = scopedTasks
      .filter((task) => task.status === "blocked")
      .sort((left, right) => left.activityUpdatedAt.localeCompare(right.activityUpdatedAt));
    const stalledTasks = activeTasks
      .filter((task) => dayGap(task.activityUpdatedAt, nowValue) >= STALL_DAYS)
      .sort((left, right) => left.activityUpdatedAt.localeCompare(right.activityUpdatedAt));
    const staleQueue = [...activeTasks]
      .sort((left, right) => left.activityUpdatedAt.localeCompare(right.activityUpdatedAt))
      .slice(0, 6);

    const weekDone = completedTasks.filter((task) => (
      nowValue - new Date(task.activityUpdatedAt).getTime() < 7 * DAY_MS
    )).length;
    const prevWeekDone = completedTasks.filter((task) => {
      const age = nowValue - new Date(task.activityUpdatedAt).getTime();
      return age >= 7 * DAY_MS && age < 14 * DAY_MS;
    }).length;

    const labelCountMap = new Map<string, number>();
    for (const task of scopedTasks) {
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
      .sort((left, right) => right.count - left.count || left.sortName.localeCompare(right.sortName));
    const totalLabelAssignments = Math.max(1, labelCounts.reduce((total, item) => total + item.count, 0));
    const labeledTaskCount = scopedTasks.filter((task) => task.labels.length > 0).length;
    const unlabeledTaskCount = Math.max(0, scopedTasks.length - labeledTaskCount);
    const scopedTaskCount = scopedTasks.length;
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
      color: item.label === "__other__"
        ? "var(--dashboard-other-label-color)"
        : LABEL_COLORS[index % LABEL_COLORS.length],
    }));

    return {
      scopedTasks, activeTasks, completedTasks, projectCompletion,
      reviewTasks, blockedTasks, stalledTasks, staleQueue, weekDone, prevWeekDone,
      labelCounts, totalLabelAssignments, labeledTaskCount,
      unlabeledTaskCount, scopedTaskCount, visibleLabelCounts,
    };
  }, [language, tasks, text, nowValue]);

  const progressData = useMemo(() => {
    const aggregateCreatedAt = isAllProjects
      ? tasks.reduce<string | null>((earliest, task) => (
          !earliest || task.createdAt < earliest ? task.createdAt : earliest
        ), null)
      : null;
    return buildProgressData(tasks, todayValue, projectCreatedAt ?? aggregateCreatedAt);
  }, [isAllProjects, projectCreatedAt, tasks, todayValue]);

  const runningTasks = useMemo(() => tasks.filter(
    (task) => presentations[task.id]?.processing.running,
  ), [presentations, tasks]);

  const summaryBody = isAllProjects
    ? text(
        `所有项目共有 ${tasks.length} 个议题，${activeTasks.length} 个未结束；${reviewTasks.length} 个等你拍板，${stalledTasks.length} 个停滞超过 ${STALL_DAYS} 天。`,
        `Across all projects, ${tasks.length} issues tracked with ${activeTasks.length} open; ${reviewTasks.length} awaiting your call and ${stalledTasks.length} stalled over ${STALL_DAYS} days.`,
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
  const summaryReady = isAllProjects || projectSummary !== null || summaryLoadFailed;

  const weekDelta = weekDone - prevWeekDone;
  const decisionTotal = reviewTasks.length + blockedTasks.length;

  return (
    <div className="dashboard-view">
      <div className="dash-wb">
        <header className="dash-hud">
          <div className="dash-hud-brief">
            <DashboardSummary
              projectId={projectId}
              summary={summaryBody}
              summaryReady={summaryReady}
              animateSummary={animateSummary}
              onSummaryAnimationStart={onSummaryAnimationStart}
            />
          </div>

          <ul className="dash-hud-pulse">
            <li className="tone-review">
              <span>{text("等你拍板", "Awaiting you")}</span>
              <strong>{reviewTasks.length}</strong>
            </li>
            <li className="tone-running">
              <span>{text("Codex 在跑", "Codex running")}</span>
              <strong>{runningTasks.length}</strong>
            </li>
            <li className="tone-stalled">
              <span>{text(`停滞 ≥${STALL_DAYS} 天`, `Stalled ≥${STALL_DAYS}d`)}</span>
              <strong>{stalledTasks.length}</strong>
            </li>
            <li className="tone-week">
              <span>{text("本周完成", "Done this week")}</span>
              <strong>
                {weekDone}
                <i className={weekDelta > 0 ? "is-up" : weekDelta < 0 ? "is-down" : undefined}>
                  {weekDelta > 0 ? `+${weekDelta}` : weekDelta < 0 ? weekDelta : "±0"}
                </i>
              </strong>
            </li>
          </ul>
        </header>

        <div className="dash-body">
          <div className="dash-main">
            <section className="dash-card">
              <header className="dash-card-head">
                <h2>{text("累计进度", "Cumulative progress")}</h2>
                <span className="dash-card-note">
                  {text(
                    `完成率 ${scopedTaskCount ? Math.round((completedTasks.length / scopedTaskCount) * 100) : 0}%`,
                    `${scopedTaskCount ? Math.round((completedTasks.length / scopedTaskCount) * 100) : 0}% done`,
                  )}
                </span>
              </header>
              <DashboardProgressChart progressData={progressData} todayValue={todayValue} />
            </section>
          </div>

          <aside className="dash-rail">
            <section className="dash-card">
              <header className="dash-card-head">
                <h2>{text("等你拍板", "Awaiting you")}</h2>
                <span className="dash-card-note">{reviewTasks.length}</span>
              </header>
              {reviewTasks.length ? (
                <ul className="dash-queue">
                  {reviewTasks.map((task) => (
                    <li key={task.id}>
                      <button type="button" className="dash-queue-item" onClick={() => onOpenTask(task)}>
                        <span>{task.title}</span>
                        <small>{task.identifier}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="dash-empty">{text("没有等着你确认的议题", "Nothing awaiting you")}</p>}
            </section>

            <section className="dash-card">
              <header className="dash-card-head">
                <h2>{text("卡住了", "Blocked")}</h2>
                <span className="dash-card-note">{blockedTasks.length}</span>
              </header>
              {blockedTasks.length ? (
                <ul className="dash-queue">
                  {blockedTasks.map((task) => (
                    <li key={task.id}>
                      <button type="button" className="dash-queue-item" onClick={() => onOpenTask(task)}>
                        <span>{task.title}</span>
                        <small>{task.identifier}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="dash-empty">{text("没有卡住的议题", "Nothing blocked")}</p>}
            </section>

            <section className="dash-card">
              <header className="dash-card-head">
                <h2>{text("最久没动", "Idle longest")}</h2>
                <span className="dash-card-note">{stalledTasks.length}</span>
              </header>
              {staleQueue.length ? (
                <ul className="dash-queue">
                  {staleQueue.map((task) => (
                    <li key={task.id}>
                      <button type="button" className="dash-queue-item" onClick={() => onOpenTask(task)}>
                        <span>{task.title}</span>
                        <small className={dayGap(task.activityUpdatedAt, nowValue) >= STALL_DAYS ? "is-stale" : undefined}>
                          {dayGap(task.activityUpdatedAt, nowValue)}{text(" 天", "d")}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="dash-empty">{text("所有议题都在推进", "Everything is moving")}</p>}
            </section>

            <section className="dash-card">
              <header className="dash-card-head">
                <h2>{text("标签覆盖", "Labels")}</h2>
                <span className="dash-card-note">
                  {text(`${labeledTaskCount}/${scopedTaskCount}`, `${labeledTaskCount}/${scopedTaskCount}`)}
                </span>
              </header>
              {visibleLabelCounts.length ? (
                <>
                  <div className="dash-labelbar" role="img" aria-label={text("标签占比", "Label share")}>
                    {visibleLabelCounts.map((item) => (
                      <i
                        key={item.label}
                        style={{
                          width: `${(item.count / totalLabelAssignments) * 100}%`,
                          background: item.color,
                        }}
                        title={`${item.presentation.name} · ${item.count}`}
                      />
                    ))}
                  </div>
                  <ul className="dash-legend">
                    {visibleLabelCounts.slice(0, 6).map((item) => (
                      <li key={item.label}>
                        <i style={{ background: item.color }} aria-hidden="true" />
                        <span>{item.presentation.name}</span>
                        <b>{item.count}</b>
                      </li>
                    ))}
                  </ul>
                  {unlabeledTaskCount ? (
                    <p className="dash-footnote">
                      {text(
                        `另有 ${unlabeledTaskCount} 个议题未打标签`,
                        `${unlabeledTaskCount} issues untagged`,
                      )}
                    </p>
                  ) : null}
                </>
              ) : <p className="dash-empty">{text("当前没有标签数据", "No label data")}</p>}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
