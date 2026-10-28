import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "./AgentOverviewView.css";
import { useTaskboardI18n, taskPriorityLabel, taskStatusLabel } from "../i18n";
import type { TaskboardLanguage } from "../i18n";
import type { ActorIdentity, Project, Task } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { getClientStorageEntries, updateClientStorageEntry, updateProjectMetric } from "../api";
import {
  DEPARTMENT_STORAGE_KEY,
  DEFAULT_DEPARTMENT_SETTINGS,
  UNASSIGNED_DEPARTMENT_ID,
  departmentName,
  parseDepartmentSettings,
  resolveDepartments,
  resolveProjectDepartments,
  serializeDepartmentSettings,
} from "../departments";
import type { Department, DepartmentSettings } from "../departments";

export interface AgentAutomationSummary {
  activeCount: number;
  intervalMinutes: number | null;
}

export interface ProjectAutomationSummary {
  enabled: boolean;
  status: "ACTIVE" | "PAUSED";
  intervalMinutes: number;
}

interface AgentOverviewViewProps {
  isAllProjects: boolean;
  selectedProjectId: string | null;
  /** Renders the project tree only, for use inside a composed overview page. */
  embedded?: boolean;
  currentUser: ActorIdentity;
  tasks: Task[];
  projects: Project[];
  presentations: Record<string, TaskCardPresentation>;
  projectNames: Record<string, string>;
  automation: AgentAutomationSummary;
  projectAutomations: Record<string, ProjectAutomationSummary>;
  automationUnavailableReason: string | null;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
  onSelectProject: (projectId: string) => void;
  onProjectMetricUpdated: (project: Project) => void;
  onSetProjectAutomation: (projectId: string, enabled: boolean) => void;
}

const DAY_MS = 86_400_000;
const RECENT_TASKS_PER_PROJECT = 4;
const HIDE_NAMES_KEY = "taskboard:hideProjectNames";
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

interface PipelineCounts {
  todo: number;
  inProgress: number;
  waiting: number;
  done7: number;
  total: number;
}

interface ProjectSummary {
  projectId: string;
  name: string;
  departmentId: string;
  counts: PipelineCounts;
  activeTasks: Task[];
  quietDays: number;
  automation: ProjectAutomationSummary | null;
}

interface DepartmentSummary {
  id: string;
  name: string;
  nameEn: string;
  isUnassigned: boolean;
  counts: PipelineCounts;
  projects: ProjectSummary[];
  automationActiveCount: number;
  automationIntervalMinutes: number | null;
}

function emptyCounts(): PipelineCounts {
  return { todo: 0, inProgress: 0, waiting: 0, done7: 0, total: 0 };
}

function daysSince(value: string | null | undefined, now: number) {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
}

function isWaitingTask(task: Task) {
  return task.status === "in_review" || task.status === "blocked";
}

function isOpenTask(task: Task) {
  return task.status !== "done" && task.status !== "canceled";
}

function countPipeline(tasks: Task[], now: number): PipelineCounts {
  const counts = emptyCounts();
  for (const task of tasks) {
    counts.total += 1;
    if (task.status === "todo") counts.todo += 1;
    else if (task.status === "in_progress") counts.inProgress += 1;
    else if (isWaitingTask(task)) counts.waiting += 1;
    if (task.status === "done" && daysSince(task.updatedAt, now) <= 7) counts.done7 += 1;
  }
  return counts;
}

function addCounts(target: PipelineCounts, source: PipelineCounts) {
  target.todo += source.todo;
  target.inProgress += source.inProgress;
  target.waiting += source.waiting;
  target.done7 += source.done7;
  target.total += source.total;
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

function startOfToday(now: number) {
  const value = new Date(now);
  value.setHours(0, 0, 0, 0);
  return value.getTime();
}

function taskFocusRank(task: Task, now: number) {
  const today = startOfToday(now);
  const due = task.dueDate ? new Date(`${task.dueDate}T00:00:00`).getTime() : null;
  const overdue = due !== null && due < today;
  const dueToday = due === today;
  const priority = PRIORITY_ORDER[task.priority] ?? 9;
  if (overdue) return 0;
  if (dueToday) return 1;
  if (task.status === "blocked") return 2;
  if (task.status === "in_review") return 3;
  return 4 + priority;
}

function focusTaskLabel(task: Task, now: number, language: TaskboardLanguage) {
  const today = startOfToday(now);
  const due = task.dueDate ? new Date(`${task.dueDate}T00:00:00`).getTime() : null;
  if (due !== null && due < today) return language === "zh" ? "已逾期" : "Overdue";
  if (due === today) return language === "zh" ? "今天到期" : "Due today";
  if (task.status === "blocked") return language === "zh" ? "遇到阻碍" : "Blocked";
  if (task.status === "in_review") return language === "zh" ? "等你确认" : "Needs review";
  return taskPriorityLabel(language, task.priority);
}

function shortDueDate(value: string, language: TaskboardLanguage) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function dueTone(task: Task, now: number) {
  if (!task.dueDate) return "";
  const due = new Date(`${task.dueDate}T00:00:00`).getTime();
  const today = startOfToday(now);
  if (due < today) return "is-overdue";
  if (due <= today + 3 * DAY_MS) return "is-soon";
  return "";
}

/* ---------- pipeline bar ---------- */

function Pipeline({
  counts,
  text,
}: {
  counts: PipelineCounts;
  text: (zh: string, en: string) => string;
}) {
  return (
    <div className="org-pipeline">
      <span className="org-stage tone-todo">
        <i aria-hidden="true" />
        {counts.todo} {text("待办", "todo")}
      </span>
      <span className="org-stage tone-progress">
        <i aria-hidden="true" />
        {counts.inProgress} {text("处理中", "running")}
      </span>
      <span className="org-stage tone-waiting">
        <i aria-hidden="true" />
        {counts.waiting} {text("等我", "for me")}
      </span>
      <span className="org-stage tone-done">
        <i aria-hidden="true" />
        {counts.done7} {text("7 天交付", "7d shipped")}
      </span>
    </div>
  );
}

/* ---------- project leaf ---------- */

interface ProjectRowProps {
  project: ProjectSummary;
  projectRecord: Project | undefined;
  departments: Department[];
  language: TaskboardLanguage;
  text: (zh: string, en: string) => string;
  hideNames: boolean;
  displayIndex: number;
  presentations: Record<string, TaskCardPresentation>;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
  onSelectProject: (projectId: string) => void;
  onProjectMetricUpdated: (project: Project) => void;
  onAssignDepartment: (projectId: string, departmentId: string) => void;
}

function ProjectRow({
  project,
  projectRecord,
  departments,
  language,
  text,
  hideNames,
  displayIndex,
  presentations,
  onOpenTask,
  onSelectProject,
  onProjectMetricUpdated,
  onAssignDepartment,
}: ProjectRowProps) {
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editValue, setEditValue] = useState("");

  const displayName = hideNames
    ? `${text("项目", "Project")} ${String.fromCharCode(65 + displayIndex)}`
    : project.name;

  const metricLabel = projectRecord?.mainMetricLabel ?? null;
  const metricValue = projectRecord?.mainMetricValue ?? null;
  const hasCustomMetric = Boolean(metricValue && metricLabel);

  const startEdit = useCallback(() => {
    setEditLabel(metricLabel ?? "");
    setEditValue(metricValue ?? "");
    setEditing(true);
  }, [metricLabel, metricValue]);

  const saveEdit = useCallback(async () => {
    if (!projectRecord) return;
    const label = editLabel.trim() || null;
    const value = editValue.trim() || null;
    setEditing(false);
    try {
      const updated = await updateProjectMetric(projectRecord.id, {
        mainMetricLabel: label,
        mainMetricValue: value,
      });
      onProjectMetricUpdated(updated);
    } catch {
      // Silently revert — the next refresh restores the true state.
    }
  }, [editLabel, editValue, projectRecord, onProjectMetricUpdated]);

  return (
    <article className="dashboard-project-card">
      <div className="org-team-head">
        <span className="org-team-branch" aria-hidden="true" />
        <div className="dashboard-project-title">
          <button
            type="button"
            className="org-team-name"
            onClick={() => onSelectProject(project.projectId)}
            title={text("打开项目", "Open project")}
          >
            {displayName}
          </button>
          <span className="org-team-activity">
            {text("最近", "Active")} {relativeDayLabel(project.quietDays, language)}
          </span>
        </div>
        <div className="dashboard-project-actions">
          {project.automation && (
            <span
              className={`org-automation-badge${project.automation.enabled ? " is-on" : ""}`}
              title={project.automation.enabled
                ? text(
                  `自动认领每 ${project.automation.intervalMinutes} 分钟`,
                  `Auto-claim every ${project.automation.intervalMinutes} min`,
                )
                : text("自动认领未开启", "Auto-claim is off")}
            >
              <i aria-hidden="true" />
              {project.automation.enabled
                ? text("自动", "auto")
                : text("手动", "manual")}
            </span>
          )}
          <select
            className="org-dept-select"
            value={project.departmentId}
            onChange={(event) => onAssignDepartment(project.projectId, event.target.value)}
            title={text("分配部门", "Assign department")}
            aria-label={text("分配部门", "Assign department")}
          >
            <option value={UNASSIGNED_DEPARTMENT_ID}>
              {text("未分组", "Unassigned")}
            </option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {departmentName(department, language)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="dashboard-project-progress">
        <div className="dashboard-project-progress-track">
          <span
            style={{
              width: `${project.counts.total > 0
                ? Math.min(100, Math.round((project.counts.done7 / project.counts.total) * 100))
                : 0}%`,
            }}
          />
        </div>
        <span>
          {project.counts.done7} {text("近 7 天完成", "shipped in 7d")}
        </span>
      </div>
      <div className="dashboard-project-stats">
        <span><strong>{project.counts.todo}</strong>{text("待办", "to do")}</span>
        <span><strong>{project.counts.inProgress}</strong>{text("处理中", "running")}</span>
        <span><strong>{project.counts.waiting}</strong>{text("等我", "for me")}</span>
        <div className="org-team-metric">
          {editing ? (
            <div className="org-metric-edit">
              <input
                className="org-metric-input"
                placeholder={text("指标名称", "Metric label")}
                value={editLabel}
                onChange={(event) => setEditLabel(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void saveEdit(); }}
                autoFocus
              />
              <input
                className="org-metric-input"
                placeholder={text("数值", "Value")}
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void saveEdit(); }}
              />
              <div className="org-metric-actions">
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
              {hasCustomMetric && (
                <>
                  <span className="org-metric-value">{metricValue}</span>
                  <span className="org-metric-label">{metricLabel}</span>
                </>
              )}
              <button
                type="button"
                className="org-metric-edit-btn"
                onClick={startEdit}
                title={text("编辑主指标", "Edit main metric")}
                aria-label={text("编辑主指标", "Edit main metric")}
              >
                ✎
              </button>
            </>
          )}
        </div>
      </div>

      {project.activeTasks.length > 0 && (
        <ul className="org-tasklist dashboard-project-tasks">
          {project.activeTasks.map((task) => {
            const presentation = presentations[task.id];
            const unread = presentation?.unread ?? false;
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className={`org-task${unread ? " is-unread" : ""}`}
                  onClick={() => onOpenTask(task)}
                  title={task.title}
                >
                  <span className={`org-task-dot tone-${task.status}`} aria-hidden="true" />
                  <span className="org-task-id">{task.identifier}</span>
                  <span className="org-task-title">{task.title}</span>
                  <span className="org-task-status">{taskStatusLabel(language, task.status)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

/* ---------- organization settings ---------- */

interface DepartmentSettingsPanelProps {
  projects: ProjectSummary[];
  departments: Department[];
  settings: DepartmentSettings;
  language: TaskboardLanguage;
  text: (zh: string, en: string) => string;
  onAssign: (projectId: string, departmentId: string) => void;
  onChange: (settings: DepartmentSettings) => void;
  onClose: () => void;
}

function DepartmentSettingsPanel({
  projects,
  departments,
  settings,
  language,
  text,
  onAssign,
  onChange,
  onClose,
}: DepartmentSettingsPanelProps) {
  const [newName, setNewName] = useState("");

  const addDepartment = () => {
    const name = newName.trim();
    if (!name) return;
    const id = `custom-${Date.now().toString(36)}`;
    setNewName("");
    onChange({
      ...settings,
      extra: [...settings.extra, { id, name, nameEn: name }],
    });
  };

  const removeDepartment = (departmentId: string) => {
    const map: Record<string, string> = {};
    for (const [projectId, value] of Object.entries(settings.map)) {
      if (value !== departmentId) map[projectId] = value;
    }
    onChange({
      ...settings,
      map,
      extra: settings.extra.filter((department) => department.id !== departmentId),
    });
  };

  return (
    <section className="org-settings">
      <header className="org-settings-head">
        <strong>{text("公司组织", "Company organization")}</strong>
        <span>
          {text(
            "把项目分给部门；部门里的任务由该部门的自动认领接手",
            "Assign projects to departments; each department claims its own tasks",
          )}
        </span>
        <button type="button" className="org-settings-close" onClick={onClose}>
          {text("收起", "Close")}
        </button>
      </header>
      <div className="org-settings-grid">
        {projects.map((project) => (
          <label className="org-settings-row" key={project.projectId}>
            <span className="org-settings-label">{project.name}</span>
            <select
              value={project.departmentId}
              onChange={(event) => onAssign(project.projectId, event.target.value)}
            >
              <option value={UNASSIGNED_DEPARTMENT_ID}>
                {text("未分配", "Unassigned")}
              </option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {departmentName(department, language)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="org-settings-new">
        <input
          value={newName}
          placeholder={text("新部门名称", "New department name")}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addDepartment(); }}
        />
        <button type="button" onClick={addDepartment}>
          {text("新建部门", "Add department")}
        </button>
      </div>
      {settings.extra.length > 0 && (
        <div className="org-settings-departments">
          <span className="org-settings-label">
            {text("自定义部门", "Custom departments")}
          </span>
          {settings.extra.map((department) => (
            <span className="org-settings-chip" key={department.id}>
              {departmentName(department, language)}
              <button
                type="button"
                onClick={() => removeDepartment(department.id)}
                title={text("删除部门", "Delete department")}
                aria-label={text("删除部门", "Delete department")}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- main view ---------- */

export function AgentOverviewView({
  isAllProjects,
  selectedProjectId,
  embedded = false,
  currentUser,
  tasks,
  projects,
  presentations,
  projectNames,
  automation,
  projectAutomations,
  automationUnavailableReason,
  onOpenTask,
  onSelectProject,
  onProjectMetricUpdated,
  onSetProjectAutomation,
}: AgentOverviewViewProps) {
  const { language, text } = useTaskboardI18n();
  const now = Date.now();
  const nowDate = new Date();

  /* Layout preferences live on the server so every browser sees the same org chart. */
  const [hideNames, setHideNames] = useState(false);
  const hideNamesTouchedRef = useRef(false);
  const toggleHideNames = useCallback(() => {
    setHideNames((previous) => {
      const next = !previous;
      hideNamesTouchedRef.current = true;
      void updateClientStorageEntry(HIDE_NAMES_KEY, next ? "1" : "0").catch(() => { /* keep the local state */ });
      return next;
    });
  }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [settings, setSettings] = useState<DepartmentSettings>(DEFAULT_DEPARTMENT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void getClientStorageEntries()
      .then((entries) => {
        if (cancelled) return;
        setSettings(parseDepartmentSettings(entries[DEPARTMENT_STORAGE_KEY] ?? null));
        if (!hideNamesTouchedRef.current) setHideNames(entries[HIDE_NAMES_KEY] === "1");
      })
      .catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, []);

  const persistSettings = useCallback((next: DepartmentSettings) => {
    setSettings(next);
    void updateClientStorageEntry(
      DEPARTMENT_STORAGE_KEY,
      serializeDepartmentSettings(next),
    ).catch(() => { /* keep the local state */ });
  }, []);

  const departments = useMemo(() => resolveDepartments(settings), [settings]);
  const projectDepartments = useMemo(
    () => resolveProjectDepartments(settings),
    [settings],
  );

  const assignProject = useCallback((projectId: string, departmentId: string) => {
    const map = { ...settings.map };
    if (departmentId === UNASSIGNED_DEPARTMENT_ID) delete map[projectId];
    else map[projectId] = departmentId;
    persistSettings({ ...settings, map });
  }, [persistSettings, settings]);

  const scopedTasks = useMemo(() => (
    isAllProjects || !selectedProjectId
      ? tasks
      : tasks.filter((task) => task.projectId === selectedProjectId)
  ), [isAllProjects, selectedProjectId, tasks]);

  const scopedProjectIds = useMemo(() => (
    isAllProjects || !selectedProjectId
      ? new Set(projects.map((project) => project.id))
      : new Set([selectedProjectId])
  ), [isAllProjects, selectedProjectId, projects]);

  const summaries = useMemo<ProjectSummary[]>(() => {
    const byProject = new Map<string, Task[]>();
    for (const task of scopedTasks) {
      const bucket = byProject.get(task.projectId);
      if (bucket) bucket.push(task);
      else byProject.set(task.projectId, [task]);
    }

    const result: ProjectSummary[] = [];
    for (const project of projects) {
      if (!scopedProjectIds.has(project.id)) continue;
      const projectTasks = byProject.get(project.id) ?? [];
      const latest = projectTasks.reduce<string | null>((value, task) => {
        const candidate = task.activityUpdatedAt > task.updatedAt
          ? task.activityUpdatedAt
          : task.updatedAt;
        return !value || candidate > value ? candidate : value;
      }, null);
      result.push({
        projectId: project.id,
        name: projectNames[project.id] ?? project.name,
        departmentId: projectDepartments.get(project.id) ?? UNASSIGNED_DEPARTMENT_ID,
        counts: countPipeline(projectTasks, now),
        activeTasks: projectTasks
          .filter(isOpenTask)
          .sort((left, right) => (
            (PRIORITY_ORDER[left.priority] ?? 9) - (PRIORITY_ORDER[right.priority] ?? 9)
            || left.updatedAt.localeCompare(right.updatedAt)
          ))
          .slice(0, RECENT_TASKS_PER_PROJECT),
        quietDays: daysSince(latest, now),
        automation: projectAutomations[project.id] ?? null,
      });
    }
    return result;
  }, [scopedTasks, scopedProjectIds, projects, projectNames, projectDepartments, projectAutomations, now]);

  const departmentsSummary = useMemo<DepartmentSummary[]>(() => {
    const unitMap = new Map<string, DepartmentSummary>();

    for (const project of summaries) {
      let unit = unitMap.get(project.departmentId);
      if (!unit) {
        const definition = departments.find((candidate) => candidate.id === project.departmentId);
        unit = {
          id: project.departmentId,
          name: project.departmentId === UNASSIGNED_DEPARTMENT_ID
            ? text("未分配", "Unassigned")
            : definition?.name ?? project.departmentId,
          nameEn: project.departmentId === UNASSIGNED_DEPARTMENT_ID
            ? "Unassigned"
            : definition?.nameEn ?? project.departmentId,
          isUnassigned: project.departmentId === UNASSIGNED_DEPARTMENT_ID,
          counts: emptyCounts(),
          projects: [],
          automationActiveCount: 0,
          automationIntervalMinutes: null,
        };
        unitMap.set(project.departmentId, unit);
      }
      addCounts(unit.counts, project.counts);
      unit.projects.push(project);
      if (project.automation?.enabled) {
        unit.automationActiveCount += 1;
        unit.automationIntervalMinutes = project.automation.intervalMinutes;
      }
    }

    for (const unit of unitMap.values()) {
      unit.projects.sort((left, right) => (
        right.counts.total - left.counts.total
        || right.counts.inProgress - left.counts.inProgress
        || left.name.localeCompare(right.name)
      ));
    }

    return [...unitMap.values()].sort((left, right) => (
      (left.isUnassigned ? 1 : 0) - (right.isUnassigned ? 1 : 0)
      || right.automationActiveCount - left.automationActiveCount
      || right.counts.inProgress - left.counts.inProgress
      || right.counts.total - left.counts.total
    ));
  }, [summaries, departments, text]);

  const runningCount = scopedTasks.filter((task) => task.status === "in_progress").length;
  const openCount = scopedTasks.filter(isOpenTask).length;
  const unassignedCount = summaries.filter(
    (project) => project.departmentId === UNASSIGNED_DEPARTMENT_ID,
  ).length;
  const focusTasks = useMemo(() => (
    [...scopedTasks]
      .filter(isOpenTask)
      .sort((left, right) => (
        taskFocusRank(left, now) - taskFocusRank(right, now)
        || (PRIORITY_ORDER[left.priority] ?? 9) - (PRIORITY_ORDER[right.priority] ?? 9)
        || left.updatedAt.localeCompare(right.updatedAt)
      ))
      .slice(0, 5)
  ), [scopedTasks, now]);

  const statusLine = automation.activeCount > 0
    ? text(
        `自动认领 · 每 ${automation.intervalMinutes ?? 0} 分钟`,
        `Auto-claim · every ${automation.intervalMinutes ?? 0} min`,
      )
    : text("自动认领未开启", "Auto-claim is off");

  const toggleDepartmentAutomation = useCallback((unit: DepartmentSummary) => {
    const enable = unit.automationActiveCount < unit.projects.length;
    for (const project of unit.projects) {
      onSetProjectAutomation(project.projectId, enable);
    }
  }, [onSetProjectAutomation]);

  return (
    <div className={`agent-overview dashboard${embedded ? " is-embedded" : ""}`}>
      <div className="dashboard-canvas">
        {/* top bar */}
        <header className="dashboard-topbar">
          <div className="dashboard-heading">
            <span className="org-logo" aria-hidden="true">◆</span>
            <span className="org-brand-name">{text("我的工作台", "My workspace")}</span>
            <span className="org-brand-sub">
              {embedded
                ? text("经营全貌", "Operating view")
                : text("一人公司运营总览", "Solo operator dashboard")}
            </span>
          </div>
          <div className="dashboard-kpis">
            <span className="org-stat">{departmentsSummary.length} {text("个部门", "units")}</span>
            <span className="org-stat">{summaries.length} {text("个项目", "projects")}</span>
            <span className="org-stat">{scopedTasks.length} {text("个议题", "issues")}</span>
            <span className="org-stat">{openCount} {text("个未结束", "open")}</span>
          </div>
          <div className="dashboard-topbar-actions">
            <span className="dashboard-time">{timeLabel(nowDate)}</span>
            <button
              type="button"
              className={`dashboard-action${settingsOpen ? " is-on" : ""}`}
              onClick={() => setSettingsOpen((previous) => !previous)}
              title={text("公司组织", "Company organization")}
            >
              {text("组织设置", "Org setup")}
            </button>
            <button
              type="button"
              className={`dashboard-action${hideNames ? " is-on" : ""}`}
              onClick={toggleHideNames}
              title={hideNames ? text("显示项目", "Show names") : text("隐藏项目", "Hide names")}
            >
              {hideNames ? text("隐藏项目", "Hide names") : text("显示项目", "Show names")}
            </button>
          </div>
        </header>

        <section className="dashboard-focus">
          <div className="dashboard-section-heading">
            <div>
              <span className="dashboard-section-kicker">{text("现在就看", "Focus now")}</span>
              <h2>{text("需要关注", "Needs attention")}</h2>
            </div>
            <span className="dashboard-section-count">{focusTasks.length} / 5</span>
          </div>
          {focusTasks.length > 0 ? (
            <div className="dashboard-focus-grid">
              {focusTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={`dashboard-focus-card tone-${task.priority}${presentations[task.id]?.unread ? " is-unread" : ""}`}
                  onClick={() => onOpenTask(task)}
                  title={task.title}
                >
                  <span className="dashboard-focus-card-top">
                    <span className="dashboard-focus-id">{task.identifier}</span>
                    <span className="dashboard-focus-tags">
                      <span className="dashboard-focus-label">{focusTaskLabel(task, now, language)}</span>
                      {task.dueDate && (
                        <span className={`dashboard-focus-due ${dueTone(task, now)}`}>
                          {shortDueDate(task.dueDate, language)}
                        </span>
                      )}
                    </span>
                  </span>
                  <strong>{task.title}</strong>
                  <span className="dashboard-focus-meta">{taskStatusLabel(language, task.status)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="dashboard-empty">{text("当前没有需要立即处理的任务", "Nothing needs your immediate attention")}</div>
          )}
        </section>

        {/* CEO layer */}
        <section className="org-lead">
          <div className="org-lead-card">
            <ActorAvatar actor={currentUser} className="org-lead-avatar" />
            <div className="org-lead-info">
              <strong>{currentUser.name}</strong>
              <span>{text("创始人 · CEO · 拍板定方向", "Founder · CEO · Sets direction")}</span>
            </div>
            <div className="org-lead-badge">
              <span className="org-badge-calm">
                {text(`${summaries.length} 个项目`, `${summaries.length} projects`)}
              </span>
            </div>
          </div>
          <div className="org-lead-agent">
            <span className="org-lead-agent-icon" aria-hidden="true">◇</span>
            <div className="org-lead-agent-info">
              <strong>CEO Agent</strong>
              <span>
                {automation.activeCount > 0
                  ? text(
                      `每 ${automation.intervalMinutes ?? 0} 分钟巡视 · 在做 ${runningCount} 件`,
                      `Every ${automation.intervalMinutes ?? 0} min · ${runningCount} running`,
                    )
                  : text("未开启自动巡视", "Auto-patrol is off")}
              </span>
            </div>
            <div className={`org-lead-agent-status${automation.activeCount > 0 ? " is-on" : ""}`}>
              <i aria-hidden="true" />
              <span>{statusLine}</span>
            </div>
          </div>
        </section>

        {/* spine */}
        <div className="org-spine" aria-hidden="true">
          <span className="org-spine-node" />
        </div>

        {/* departments */}
        <section className="dashboard-projects">
          <div className="dashboard-section-heading">
            <div>
              <span className="dashboard-section-kicker">{text("经营全貌", "Operating view")}</span>
              <h2>{text("项目进展", "Projects")}</h2>
            </div>
            <span className="dashboard-section-count">{summaries.length} {text("个项目", "projects")}</span>
            <button
              type="button"
              className={`dashboard-projects-toggle${projectsExpanded ? " is-open" : ""}`}
              aria-expanded={projectsExpanded}
              onClick={() => setProjectsExpanded((previous) => !previous)}
            >
              {projectsExpanded ? text("收起", "Collapse") : text("展开全部", "Expand all")}
              <i aria-hidden="true">⌄</i>
            </button>
          </div>
          {!projectsExpanded ? (
            <div className="dashboard-project-chips">
              {summaries.map((project, index) => (
                <button
                  type="button"
                  className="dashboard-project-chip"
                  key={project.projectId}
                  onClick={() => onSelectProject(project.projectId)}
                  title={text("打开项目", "Open project")}
                >
                  <strong>
                    {hideNames
                      ? `${text("项目", "Project")} ${String.fromCharCode(65 + index)}`
                      : project.name}
                  </strong>
                  <span>
                    {project.counts.todo} {text("待办", "todo")}
                    {" · "}
                    {project.counts.inProgress} {text("处理中", "doing")}
                  </span>
                </button>
              ))}
            </div>
          ) : departmentsSummary.map((unit) => {
            const automationOn = unit.automationActiveCount > 0;
            const automationAll = unit.projects.length > 0
              && unit.automationActiveCount === unit.projects.length;
            return (
              <article
                className={`dashboard-group${unit.isUnassigned ? " is-unassigned" : ""}`}
                key={unit.id}
              >
                <div className="org-unit-rail" aria-hidden="true">
                  <span className="org-unit-node" />
                </div>
                <div className="dashboard-group-shell">
                  <header className="dashboard-group-head">
                    <div className="org-unit-title">
                      <strong>{language === "zh" ? unit.name : unit.nameEn}</strong>
                      <span>{unit.projects.length} {text("个项目", "projects")}</span>
                    </div>
                    <div
                      className={`org-unit-automation${automationOn ? " is-on" : ""}`}
                      title={unit.automationIntervalMinutes
                        ? text(
                            `自动认领每 ${unit.automationIntervalMinutes} 分钟`,
                            `Auto-claim every ${unit.automationIntervalMinutes} min`,
                          )
                        : text("自动认领未开启", "Auto-claim is off")}
                    >
                      <i aria-hidden="true" />
                      <span>
                        {unit.automationActiveCount}/{unit.projects.length} {text("自动认领", "auto")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`org-automation-toggle${automationAll ? " is-on" : ""}`}
                      onClick={() => toggleDepartmentAutomation(unit)}
                      disabled={Boolean(automationUnavailableReason)}
                      title={automationUnavailableReason ?? (
                        automationAll
                          ? text("关闭本部门自动认领", "Turn off auto-claim for this department")
                          : text("开启本部门自动认领", "Turn on auto-claim for this department")
                      )}
                    >
                      {automationAll
                        ? text("本部门自动认领已开", "Auto-claim on")
                        : text("开启本部门自动认领", "Turn on auto-claim")}
                    </button>
                    <Pipeline counts={unit.counts} text={text} />
                  </header>
                  <div className="dashboard-project-grid">
                    {unit.projects.map((project, index) => (
                      <ProjectRow
                        key={`${unit.id}-${project.projectId}`}
                        project={project}
                        projectRecord={projects.find((candidate) => candidate.id === project.projectId)}
                        departments={departments}
                        language={language}
                        text={text}
                        hideNames={hideNames}
                        displayIndex={index}
                        presentations={presentations}
                        onOpenTask={onOpenTask}
                        onSelectProject={onSelectProject}
                        onProjectMetricUpdated={onProjectMetricUpdated}
                        onAssignDepartment={assignProject}
                      />
                    ))}
                  </div>
                </div>
              </article>
            );
          })}
        </section>

        {settingsOpen && (
          <DepartmentSettingsPanel
            projects={summaries}
            departments={departments}
            settings={settings}
            language={language}
            text={text}
            onAssign={assignProject}
            onChange={persistSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        <footer className="dashboard-footer">
          <span>{summaries.length} {text("个项目已归部", "projects assigned")}</span>
          <i aria-hidden="true">·</i>
          <span>{unassignedCount} {text("个项目未分配", "unassigned")}</span>
          <i aria-hidden="true">·</i>
          <span>{automation.activeCount} {text("个项目自动认领中", "auto-claim on")}</span>
          <i aria-hidden="true">·</i>
          <span>{runningCount} {text("件处理中", "running")}</span>
        </footer>
      </div>
    </div>
  );
}
