import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sortTasksByClaimPriority } from "../shared/taskboard-automation.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

const actor = {
  type: "user",
  id: "claim-priority-tester",
  name: "Claim Priority Tester",
  avatarUrl: null,
};

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-claim-priority-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  return {
    database,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createTask(database, projectId, title, overrides = {}) {
  return database.createTask({
    projectId,
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    ...overrides,
  });
}

test("sortTasksByClaimPriority: 按优先级排序", () => {
  const tasks = [
    { id: "1", priority: "low", sortOrder: 1, createdAt: "2024-01-01T00:00:00Z" },
    { id: "2", priority: "urgent", sortOrder: 2, createdAt: "2024-01-02T00:00:00Z" },
    { id: "3", priority: "high", sortOrder: 3, createdAt: "2024-01-03T00:00:00Z" },
  ];
  const sorted = sortTasksByClaimPriority(tasks);
  assert.deepEqual(sorted.map(t => t.id), ["2", "3", "1"]);
});

test("sortTasksByClaimPriority: 同优先级按sortOrder排序", () => {
  const tasks = [
    { id: "1", priority: "high", sortOrder: 3, createdAt: "2024-01-01T00:00:00Z" },
    { id: "2", priority: "high", sortOrder: 1, createdAt: "2024-01-02T00:00:00Z" },
    { id: "3", priority: "high", sortOrder: 2, createdAt: "2024-01-03T00:00:00Z" },
  ];
  const sorted = sortTasksByClaimPriority(tasks);
  assert.deepEqual(sorted.map(t => t.id), ["2", "3", "1"]);
});

test("sortTasksByClaimPriority: 同优先级同sortOrder按创建时间排序", () => {
  const tasks = [
    { id: "1", priority: "medium", sortOrder: 1, createdAt: "2024-01-03T00:00:00Z" },
    { id: "2", priority: "medium", sortOrder: 1, createdAt: "2024-01-01T00:00:00Z" },
    { id: "3", priority: "medium", sortOrder: 1, createdAt: "2024-01-02T00:00:00Z" },
  ];
  const sorted = sortTasksByClaimPriority(tasks);
  assert.deepEqual(sorted.map(t => t.id), ["2", "3", "1"]);
});

test("sortTasksByClaimPriority: 综合场景", () => {
  const tasks = [
    { id: "1", priority: "low", sortOrder: 1, createdAt: "2024-01-01T00:00:00Z" },
    { id: "2", priority: "urgent", sortOrder: 5, createdAt: "2024-01-05T00:00:00Z" },
    { id: "3", priority: "high", sortOrder: 2, createdAt: "2024-01-02T00:00:00Z" },
    { id: "4", priority: "urgent", sortOrder: 3, createdAt: "2024-01-03T00:00:00Z" },
    { id: "5", priority: "medium", sortOrder: 4, createdAt: "2024-01-04T00:00:00Z" },
  ];
  const sorted = sortTasksByClaimPriority(tasks);
  assert.deepEqual(sorted.map(t => t.id), ["4", "2", "3", "5", "1"]);
});

test("sortTasksByClaimPriority: 缺失优先级与缺失字段按最低优先级处理", () => {
  const tasks = [
    { id: "1", sortOrder: 0, createdAt: "2024-01-01T00:00:00Z" },
    { id: "2", priority: "none", sortOrder: 0, createdAt: "2024-01-01T00:00:00Z" },
    { id: "3", priority: "medium", sortOrder: 9, createdAt: "2024-01-01T00:00:00Z" },
  ];
  const sorted = sortTasksByClaimPriority(tasks);
  assert.deepEqual(sorted.map(t => t.id), ["3", "1", "2"]);
});

test("sortTasksByClaimPriority: 不会修改入参数组顺序", () => {
  const tasks = [
    { id: "1", priority: "low", sortOrder: 1, createdAt: "2024-01-01T00:00:00Z" },
    { id: "2", priority: "urgent", sortOrder: 2, createdAt: "2024-01-02T00:00:00Z" },
  ];
  sortTasksByClaimPriority(tasks);
  assert.deepEqual(tasks.map(t => t.id), ["1", "2"]);
});

test("listTasks sort=priority: 先按优先级，再按手动排序", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createProject({
      id: "claim-order",
      name: "Claim Order",
      workspacePath: "/tmp/claim-order",
    });
    createTask(fixture.database, "claim-order", "Medium first by sortOrder", {
      priority: "medium",
      sortOrder: -10,
    });
    createTask(fixture.database, "claim-order", "Urgent later by sortOrder", {
      priority: "urgent",
      sortOrder: 100,
    });
    createTask(fixture.database, "claim-order", "High earlier by sortOrder", {
      priority: "high",
      sortOrder: 50,
    });
    createTask(fixture.database, "claim-order", "High later by sortOrder", {
      priority: "high",
      sortOrder: 60,
    });

    const manual = fixture.database.listTasks({ projectId: "claim-order", status: "todo" });
    assert.deepEqual(manual.map((task) => task.title), [
      "Medium first by sortOrder",
      "High earlier by sortOrder",
      "High later by sortOrder",
      "Urgent later by sortOrder",
    ]);

    const claimed = fixture.database.listTasks({
      projectId: "claim-order",
      status: "todo",
      sort: "priority",
    });
    assert.deepEqual(claimed.map((task) => task.title), [
      "Urgent later by sortOrder",
      "High earlier by sortOrder",
      "High later by sortOrder",
      "Medium first by sortOrder",
    ]);
  } finally {
    await fixture.close();
  }
});

test("同状态 move：只改绑定时原位保留，不改绑定时挪到列末尾", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createProject({
      id: "claim-order",
      name: "Claim Order",
      workspacePath: "/tmp/claim-order",
    });
    const first = createTask(fixture.database, "claim-order", "First", {
      priority: "high",
      sortOrder: 100,
    });
    const second = createTask(fixture.database, "claim-order", "Second", {
      priority: "high",
      sortOrder: 200,
    });

    const kept = fixture.database.moveTask(
      first.id,
      first.version,
      "todo",
      undefined,
      "thread-bound",
      { threadId: "thread-bound" },
      actor,
      null,
    );
    assert.equal(kept.sortOrder, 100);

    const bumped = fixture.database.moveTask(
      second.id,
      second.version,
      "todo",
      undefined,
      undefined,
      undefined,
      actor,
      null,
    );
    assert.equal(bumped.sortOrder, 1100);
  } finally {
    await fixture.close();
  }
});
