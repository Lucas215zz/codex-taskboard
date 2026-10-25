/*
 * Department (org unit) model for the Agent overview.
 *
 * A solo-founder company has functional departments even when a single human
 * owns all of them. Departments are derived from task labels, so the panel
 * never invents work: a task belongs to a department because somebody tagged
 * it that way.
 */

export interface Department {
  id: string;
  name: string;
  nameEn: string;
}

export const UNCLASSIFIED_DEPARTMENT_ID = "unclassified";
export const DEPARTMENT_STORAGE_KEY = "taskboard.departmentMap";

export const BUILT_IN_DEPARTMENTS: Department[] = [
  { id: "engineering", name: "研发部", nameEn: "Engineering" },
  { id: "product", name: "产品部", nameEn: "Product" },
  { id: "operations", name: "运营部", nameEn: "Operations" },
  { id: "marketing", name: "市场部", nameEn: "Marketing" },
  { id: "finance", name: "财务部", nameEn: "Finance" },
  { id: "ceo", name: "CEO 直属", nameEn: "Direct to CEO" },
];

/*
 * Default label -> department assignment.
 *
 * Priority labels (P0/P1/P2), stage markers (phase-*) and workflow markers
 * (hold, for-claude) deliberately stay out: they describe urgency, not the
 * department that owns the work.
 */
export const DEFAULT_LABEL_DEPARTMENT: Record<string, string> = {
  // 研发部
  "运维": "engineering",
  "前端": "engineering",
  "数据": "engineering",
  "多语言": "engineering",
  "安全": "engineering",
  "技术债": "engineering",
  "发布流程": "engineering",
  "环境核对": "engineering",
  "版本控制": "engineering",
  "本地环境": "engineering",
  "测试基线": "engineering",
  "测试": "engineering",
  "test": "engineering",
  "缺陷": "engineering",
  "接手": "engineering",
  // 产品部
  "特性": "product",
  "改进": "product",
  "UX": "product",
  // 运营部
  "运营": "operations",
  "客服": "operations",
  "内容": "operations",
  // 市场部
  "市场": "marketing",
  "投放": "marketing",
  "品牌": "marketing",
  "达人": "marketing",
  "联盟": "marketing",
  // 财务部
  "结算": "finance",
  "成本": "finance",
  "收入": "finance",
  "价格": "finance",
  // CEO 直属
  "需老板": "ceo",
};

export interface DepartmentSettings {
  map: Record<string, string>;
  extra: Department[];
}

export const DEFAULT_DEPARTMENT_SETTINGS: DepartmentSettings = {
  map: {},
  extra: [],
};

export function parseDepartmentSettings(raw: string | null | undefined): DepartmentSettings {
  if (!raw) return DEFAULT_DEPARTMENT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<DepartmentSettings>;
    const map: Record<string, string> = {};
    if (parsed.map && typeof parsed.map === "object") {
      for (const [label, departmentId] of Object.entries(parsed.map)) {
        if (typeof label === "string" && typeof departmentId === "string") {
          map[label] = departmentId;
        }
      }
    }
    const extra: Department[] = [];
    if (Array.isArray(parsed.extra)) {
      for (const entry of parsed.extra) {
        if (entry && typeof entry.id === "string" && typeof entry.name === "string") {
          extra.push({
            id: entry.id,
            name: entry.name,
            nameEn: typeof entry.nameEn === "string" ? entry.nameEn : entry.name,
          });
        }
      }
    }
    return { map, extra };
  } catch {
    return DEFAULT_DEPARTMENT_SETTINGS;
  }
}

export function serializeDepartmentSettings(settings: DepartmentSettings): string {
  return JSON.stringify({ map: settings.map, extra: settings.extra });
}

export function resolveDepartments(settings: DepartmentSettings): Department[] {
  return [...BUILT_IN_DEPARTMENTS, ...settings.extra];
}

export function resolveLabelDepartments(
  settings: DepartmentSettings,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [label, departmentId] of Object.entries(DEFAULT_LABEL_DEPARTMENT)) {
    map.set(label, departmentId);
  }
  for (const [label, departmentId] of Object.entries(settings.map)) {
    // An empty override means "explicitly unclassified" and must beat the
    // built-in default, otherwise the select snaps back to the default.
    if (departmentId) map.set(label, departmentId);
    else map.delete(label);
  }
  return map;
}

export function departmentOfLabels(
  labels: string[],
  map: Map<string, string>,
): string | null {
  for (const label of labels) {
    const departmentId = map.get(label);
    if (departmentId) return departmentId;
  }
  return null;
}

export function departmentName(
  department: Department,
  language: "zh" | "en",
): string {
  return language === "zh" ? department.name : department.nameEn;
}
