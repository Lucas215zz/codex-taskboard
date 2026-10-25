/*
 * Department model for the Agent overview.
 *
 * A solo-founder company has functional departments even when a single human
 * owns all of them. Departments are assigned to projects by hand: the founder
 * decides that "CreatorPicks is product work" and "Taskboard is engineering
 * work". Tasks never decide their own department — they inherit it from the
 * project they belong to.
 */

export interface Department {
  id: string;
  name: string;
  nameEn: string;
}

/* Projects that have not been assigned to a department yet. */
export const UNASSIGNED_DEPARTMENT_ID = "unassigned";
export const DEPARTMENT_STORAGE_KEY = "taskboard.departments";

export const BUILT_IN_DEPARTMENTS: Department[] = [
  { id: "engineering", name: "研发部", nameEn: "Engineering" },
  { id: "product", name: "产品部", nameEn: "Product" },
  { id: "operations", name: "运营部", nameEn: "Operations" },
  { id: "marketing", name: "市场部", nameEn: "Marketing" },
  { id: "finance", name: "财务部", nameEn: "Finance" },
  { id: "ceo", name: "CEO 直属", nameEn: "Direct to CEO" },
];

export interface DepartmentSettings {
  /* projectId -> departmentId */
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
      for (const [projectId, departmentId] of Object.entries(parsed.map)) {
        if (typeof projectId === "string" && typeof departmentId === "string") {
          map[projectId] = departmentId;
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

export function resolveProjectDepartments(
  settings: DepartmentSettings,
): Map<string, string> {
  return new Map(Object.entries(settings.map));
}

export function departmentName(
  department: Department,
  language: "zh" | "en",
): string {
  return language === "zh" ? department.name : department.nameEn;
}
