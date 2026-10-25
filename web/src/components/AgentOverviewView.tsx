import { useCallback, useEffect, useMemo, useState } from "react";

import "./AgentOverviewView.css";
import { useTaskboardI18n, taskStatusLabel } from "../i18n";
import type { TaskboardLanguage } from "../i18n";
import type { ActorIdentity, Project, Task } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { getClientStorageEntries, updateClientStorageEntry, updateProjectMetric } from "../api";
import {
  DEPARTMENT_STORAGE_KEY,
  DEFAULT_DEPARTMENT_SETTINGS,
  UNCLASSIFIED_DEPARTMENT_ID,
  departmentName,
  departmentOfLabels,
  parseDepartmentSettings,
  resolveDepartments,
  resolveLabelDepartments,
  serializeDepartmentSettings,
} from "../departments";
import type { Department, DepartmentSettings } from "../departments";

export interface AgentAutomationSummary {
  activeCount: number;
  intervalMinutes: number | null;
}

interface AgentOverviewViewProps {
  isAllProjects: boolean;
  selectedProjectId: string | null;
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
const RECENT_TASKS_PER_TEAM = 4;
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

interface TeamSummary {
  projectId: string;
  name: string;
  counts: PipelineCounts;
  activeTasks: Task[];
  quietDays: number;
}

interface UnitSummary {
  id: string;
  name: string;
  nameEn: string;
  isUnclassified: boolean;
  counts: PipelineCounts;
  teams: TeamSummary[];
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

/* ---------- team (project) leaf ---------- */

interface TeamRowProps {
  team: TeamSummary;
  project: Project | undefined;
  language: TaskboardLanguage;
  text: (zh: string, en: string) => string;
  hideNames: boolean;
  displayIndex: number;
  presentations: Record<string, TaskCardPresentation>;
  onOpenTask: (task: Pick<Task, "identifier" | "projectId">) => void;
  onSelectProject: (projectId: string) => void;
  onProjectMetricUpdated: (project: Project) => void;
}

function TeamRow({
  team,
  project,
  language,
  text,
  hideNames,
  displayIndex,
  presentations,
  onOpenTask,
  onSelectProject,
  onProjectMetricUpdated,
}: TeamRowProps) {
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editValue, setEditValue] = useState("");

  const displayName = hideNames
    ? `${text("项目", "Project")} ${String.fromCharCode(65 + displayIndex)}`
    : team.name;

  const metricLabel = project?.mainMetricLabel ?? null;
  const metricValue = project?.mainMetricValue ?? null;
  const hasCustomMetric = Boolean(metricValue && metricLabel);

  const startEdit = useCallback(() => {
    setEditLabel(metricLabel ?? "");
    setEditValue(metricValue ?? "");
    setEditing(true);
  }, [metricLabel, metricValue]);

  const saveEdit = useCallback(async () => {
    if (!project) return;
    const label = editLabel.trim() || null;
    const value = editValue.trim() || null;
    setEditing(false);
    try {
      const updated = await updateProjectMetric(project.id, {
        mainMetricLabel: label,
        mainMetricValue: value,
      });
      onProjectMetricUpdated(updated);
    } catch {
      // Silently revert — the next refresh restores the true state.
    }
  }, [editLabel, editValue, project, onProjectMetricUpdated]);

  return (
    <div className="org-team">
      <div className="org-team-head">
        <span className="org-team-branch" aria-hidden="true" />
        <button
          type="button"
          className="org-team-name"
          onClick={() => onSelectProject(team.projectId)}
          title={text("打开项目", "Open project")}
        >
          {displayName}
        </button>
        <span className="org-team-activity">
          {text("动静", "last")} {relativeDayLabel(team.quietDays, language)}
        </span>
        <Pipeline counts={team.counts} text={text} />
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

      {team.activeTasks.length > 0 && (
        <ul className="org-tasklist">
          {team.activeTasks.map((task) => {
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
    </div>
  );
}

/* ---------- department settings ---------- */

interface DepartmentSettingsPanelProps {
  labels: string[];
  departments: Department[];
  settings: DepartmentSettings;
  language: TaskboardLanguage;
  text: (zh: string, en: string) => string;
  onChange: (settings: DepartmentSettings) => void;
  onClose: () => void;
}

function DepartmentSettingsPanel({
  labels,
  departments,
  settings,
  language,
  text,
  onChange,
  onClose,
}: DepartmentSettingsPanelProps) {
  const [newName, setNewName] = useState("");
  const effective = resolveLabelDepartments(settings);

  const assign = (label: string, departmentId: string) => {
    const map = { ...settings.map };
    // Keep an explicit empty value so "未归类" overrides the built-in default.
    map[label] = departmentId;
    onChange({ ...settings, map });
  };

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

  return (
    <section className="org-settings">
      <header className="org-settings-head">
        <strong>{text("组织架构设置", "Org settings")}</strong>
        <span>
          {text(
            "把任务标签归到部门；没有部门的任务会落在「未归类」",
            "Assign task labels to departments; tasks without one land in Unclassified",
          )}
        </span>
        <button type="button" className="org-settings-close" onClick={onClose}>
          {text("收起", "Close")}
        </button>
      </header>
      <div className="org-settings-grid">
        {labels.map((label) => (
          <label className="org-settings-row" key={label}>
            <span className="org-settings-label">{label}</span>
            <select
              value={effective.get(label) ?? ""}
              onChange={(event) => assign(label, event.target.value)}
            >
              <option value="">{text("未归类", "Unclassified")}</option>
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
    </section>
  );
}

/* ---------- main view ---------- */

export function AgentOverviewView({
  isAllProjects,
  selectedProjectId,
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<DepartmentSettings>(DEFAULT_DEPARTMENT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void getClientStorageEntries()
      .then((entries) => {
        if (cancelled) return;
        setSettings(parseDepartmentSettings(entries[DEPARTMENT_STORAGE_KEY] ?? null));
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
  const labelDepartments = useMemo(() => resolveLabelDepartments(settings), [settings]);

  const scopedTasks = useMemo(() => (
    isAllProjects || !selectedProjectId
      ? tasks
      : tasks.filter((task) => task.projectId === selectedProjectId)
  ), [isAllProjects, selectedProjectId, tasks]);

  const units = useMemo<UnitSummary[]>(() => {
    const unitMap = new Map<string, UnitSummary>();
    const teamsByUnit = new Map<string, Map<string, TeamSummary>>();
    const latestByProject = new Map<string, string>();

    for (const task of scopedTasks) {
      const activityAt = task.activityUpdatedAt > task.updatedAt
        ? task.activityUpdatedAt
        : task.updatedAt;
      const knownLatest = latestByProject.get(task.projectId);
      if (!knownLatest || activityAt > knownLatest) {
        latestByProject.set(task.projectId, activityAt);
      }

      const departmentId = departmentOfLabels(task.labels, labelDepartments)
        ?? UNCLASSIFIED_DEPARTMENT_ID;
      let unit = unitMap.get(departmentId);
      if (!unit) {
        const definition = departments.find((candidate) => candidate.id === departmentId);
        unit = {
          id: departmentId,
          name: departmentId === UNCLASSIFIED_DEPARTMENT_ID
            ? text("未归类", "Unclassified")
            : definition?.name ?? departmentId,
          nameEn: departmentId === UNCLASSIFIED_DEPARTMENT_ID
            ? "Unclassified"
            : definition?.nameEn ?? departmentId,
          isUnclassified: departmentId === UNCLASSIFIED_DEPARTMENT_ID,
          counts: emptyCounts(),
          teams: [],
        };
        unitMap.set(departmentId, unit);
      }
      addCounts(unit.counts, countPipeline([task], now));

      let teams = teamsByUnit.get(departmentId);
      if (!teams) {
        teams = new Map<string, TeamSummary>();
        teamsByUnit.set(departmentId, teams);
      }
      let team = teams.get(task.projectId);
      if (!team) {
        team = {
          projectId: task.projectId,
          name: projectNames[task.projectId] ?? task.projectId,
          counts: emptyCounts(),
          activeTasks: [],
          quietDays: 0,
        };
        teams.set(task.projectId, team);
        unit.teams.push(team);
      }
      addCounts(team.counts, countPipeline([task], now));
      if (isOpenTask(task)) team.activeTasks.push(task);
    }

    for (const unit of unitMap.values()) {
      for (const team of unit.teams) {
        team.activeTasks = team.activeTasks
          .sort((left, right) => (
            (PRIORITY_ORDER[left.priority] ?? 9) - (PRIORITY_ORDER[right.priority] ?? 9)
            || left.updatedAt.localeCompare(right.updatedAt)
          ))
          .slice(0, RECENT_TASKS_PER_TEAM);
        team.quietDays = daysSince(latestByProject.get(team.projectId) ?? null, now);
      }
      unit.teams.sort((left, right) => (
        right.counts.total - left.counts.total
        || right.counts.inProgress - left.counts.inProgress
      ));
    }

    return [...unitMap.values()].sort((left, right) => (
      (left.isUnclassified ? 1 : 0) - (right.isUnclassified ? 1 : 0)
      || right.counts.waiting - left.counts.waiting
      || right.counts.inProgress - left.counts.inProgress
      || right.counts.total - left.counts.total
    ));
  }, [scopedTasks, projectNames, labelDepartments, departments, now, text]);

  const labelsInUse = useMemo(() => {
    const labels = new Set<string>();
    for (const task of scopedTasks) {
      for (const label of task.labels) labels.add(label);
    }
    return [...labels].sort((left, right) => left.localeCompare(right));
  }, [scopedTasks]);

  const projectOrder = useMemo(() => {
    const order = new Map<string, number>();
    for (const unit of units) {
      for (const team of unit.teams) {
        if (!order.has(team.projectId)) order.set(team.projectId, order.size);
      }
    }
    return order;
  }, [units]);

  const waitingOnYou = useMemo(() => scopedTasks
    .filter(isWaitingTask)
    .sort((left, right) => {
      const leftUnread = presentations[left.id]?.unread ? 1 : 0;
      const rightUnread = presentations[right.id]?.unread ? 1 : 0;
      return rightUnread - leftUnread
        || left.activityUpdatedAt.localeCompare(right.activityUpdatedAt);
    }), [presentations, scopedTasks]);

  const runningCount = scopedTasks.filter((task) => task.status === "in_progress").length;
  const openCount = scopedTasks.filter(isOpenTask).length;
  const unreadCount = waitingOnYou.filter((task) => presentations[task.id]?.unread).length;
  const doneLast7 = scopedTasks.filter(
    (task) => task.status === "done" && daysSince(task.updatedAt, now) <= 7,
  ).length;
  const activeUnits = units.filter((unit) => unit.counts.inProgress > 0).length;
  const unclassified = units.find((unit) => unit.isUnclassified);
  const stalledUnits = units.filter(
    (unit) => unit.teams.some((team) => team.quietDays >= 7),
  ).length;

  const statusLine = automation.activeCount > 0
    ? text(
        `自动认领 · 每 ${automation.intervalMinutes ?? 0} 分钟`,
        `Auto-claim · every ${automation.intervalMinutes ?? 0} min`,
      )
    : text("自动认领未开启", "Auto-claim is off");

  return (
    <div className="agent-overview orgchart">
      <div className="org-canvas">
        {/* top bar */}
        <header className="org-topbar">
          <div className="org-brand">
            <span className="org-logo" aria-hidden="true">◆</span>
            <span className="org-brand-name">Taskboard</span>
            <span className="org-brand-sub">{text("公司组织架构", "Company Org Chart")}</span>
          </div>
          <div className="org-topbar-stats">
            <span className="org-stat">{units.length} {text("个部门", "units")}</span>
            <span className="org-stat">{scopedTasks.length} {text("个议题", "issues")}</span>
            <span className="org-stat">{openCount} {text("个未结束", "open")}</span>
            <span className="org-stat">{activeUnits} {text("个部门在干活", "active")}</span>
          </div>
          <div className="org-topbar-right">
            <span className="org-time">{timeLabel(nowDate)}</span>
            <button
              type="button"
              className={`org-toggle${settingsOpen ? " is-on" : ""}`}
              onClick={() => setSettingsOpen((previous) => !previous)}
              title={text("组织架构设置", "Org settings")}
            >
              {text("组织设置", "Org setup")}
            </button>
            <button
              type="button"
              className={`org-toggle${hideNames ? " is-on" : ""}`}
              onClick={toggleHideNames}
              title={hideNames ? text("显示项目名", "Show names") : text("隐藏项目名", "Hide names")}
            >
              {hideNames ? text("隐藏项目名", "Hide names") : text("显示项目名", "Show names")}
            </button>
          </div>
        </header>

        {/* CEO layer */}
        <section className="org-lead">
          <div className="org-lead-card">
            <ActorAvatar actor={currentUser} className="org-lead-avatar" />
            <div className="org-lead-info">
              <strong>{currentUser.name}</strong>
              <span>{text("创始人 · CEO · 拍板定方向", "Founder · CEO · Sets direction")}</span>
            </div>
            <div className="org-lead-badge">
              {waitingOnYou.length > 0 ? (
                <span className="org-badge-hot">
                  {text(`等你 ${waitingOnYou.length} 件`, `${waitingOnYou.length} waiting`)}
                </span>
              ) : (
                <span className="org-badge-calm">{text("没有等你的事", "Nothing waiting")}</span>
              )}
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
        <section className="org-tree">
          {units.map((unit) => (
            <article
              className={`org-unit${unit.isUnclassified ? " is-unclassified" : ""}`}
              key={unit.id}
            >
              <div className="org-unit-rail" aria-hidden="true">
                <span className="org-unit-node" />
              </div>
              <div className="org-unit-card">
                <header className="org-unit-head">
                  <div className="org-unit-title">
                    <strong>{language === "zh" ? unit.name : unit.nameEn}</strong>
                    <span>{unit.counts.total} {text("项", "items")}</span>
                  </div>
                  <Pipeline counts={unit.counts} text={text} />
                </header>
                <div className="org-teams">
                  {unit.teams.map((team) => (
                    <TeamRow
                      key={`${unit.id}-${team.projectId}`}
                      team={team}
                      project={projects.find((candidate) => candidate.id === team.projectId)}
                      language={language}
                      text={text}
                      hideNames={hideNames}
                      displayIndex={projectOrder.get(team.projectId) ?? 0}
                      presentations={presentations}
                      onOpenTask={onOpenTask}
                      onSelectProject={onSelectProject}
                      onProjectMetricUpdated={onProjectMetricUpdated}
                    />
                  ))}
                </div>
              </div>
            </article>
          ))}
        </section>

        {settingsOpen && (
          <DepartmentSettingsPanel
            labels={labelsInUse}
            departments={departments}
            settings={settings}
            language={language}
            text={text}
            onChange={persistSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        {/* footer summary */}
        <footer className="org-foot">
          <span>{doneLast7} {text("件 7 天交付", "shipped in 7d")}</span>
          <i aria-hidden="true">·</i>
          <span>
            {waitingOnYou.length} {text("件等你", "waiting on you")}
            {unreadCount > 0 && (
              <em className="org-unread">({unreadCount} {text("未读", "unread")})</em>
            )}
          </span>
          <i aria-hidden="true">·</i>
          <span>{stalledUnits} {text("个部门停滞", "stalled")}</span>
          <i aria-hidden="true">·</i>
          <span>
            {unclassified?.counts.total ?? 0} {text("件未归类", "unclassified")}
          </span>
        </footer>
      </div>
    </div>
  );
}
