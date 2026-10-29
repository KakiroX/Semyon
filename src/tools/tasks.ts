import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import type { Row } from "../db.js";
import { assert, findById, nowSql, today, updateRow } from "../util.js";

/**
 * Projects and tasks with dependencies — modeled on the monday.com MCP:
 * boards, owners, due dates, blockers and workload at a glance.
 */

export const TASK_STATUSES = ["todo", "doing", "blocked", "done"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const RELATED_TYPES = ["contact", "company", "deal", "order", "ticket", "product", "purchase_order"] as const;

export function taskTools(ctx: Ctx) {
  const { db, events } = ctx;

  function projectId(name?: string): number | undefined {
    if (!name) return undefined;
    const p = db.get<{ id: number }>("SELECT id FROM projects WHERE name = ? COLLATE NOCASE", name);
    return p?.id ?? db.run("INSERT INTO projects (name) VALUES (?)", name).id;
  }

  function openDependencies(taskId: number): Row[] {
    return db.all(
      `SELECT t.id, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
       WHERE d.task_id = ? AND t.status != 'done'`,
      taskId,
    );
  }

  /** True if `dependsOn` already (transitively) depends on `taskId`. */
  function wouldCycle(taskId: number, dependsOn: number): boolean {
    if (taskId === dependsOn) return true;
    const row = db.get(
      `WITH RECURSIVE chain(id) AS (
         SELECT depends_on_id FROM task_dependencies WHERE task_id = ?
         UNION SELECT d.depends_on_id FROM task_dependencies d JOIN chain c ON d.task_id = c.id)
       SELECT 1 FROM chain WHERE id = ?`,
      dependsOn,
      taskId,
    );
    return !!row;
  }

  function addDependencies(taskId: number, ids: number[]) {
    for (const dep of ids) {
      findById(db, "tasks", dep, "Task");
      assert(!wouldCycle(taskId, dep), `Task #${taskId} cannot depend on #${dep}: that would create a cycle`);
      db.run("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", taskId, dep);
    }
  }

  function getTask(id: number): Row & { blocked_by: Row[]; overdue: boolean } {
    const t = db.get("SELECT t.*, p.name AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?", id);
    assert(t, `Task #${id} not found`);
    const blockedBy = openDependencies(id);
    return {
      ...t,
      depends_on: db.all<{ depends_on_id: number }>("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?", id).map((r) => r.depends_on_id),
      blocked_by: blockedBy,
      overdue: t.status !== "done" && !!t.due_date && String(t.due_date) < today(),
    };
  }

  return [
    defineTool({
      name: "project_upsert",
      title: "Create or update project",
      description: "A project/board groups tasks, e.g. 'Black Friday prep', 'Launch ESP32 kit', 'Warehouse move'.",
      input: {
        name: z.string().min(1),
        description: z.string().optional(),
        status: z.enum(["active", "on_hold", "done"]).optional(),
      },
      handler: (a) => {
        const id = projectId(a.name)!;
        updateRow(db, "projects", id, { description: a.description, status: a.status }, false);
        return { project: findById(db, "projects", id) };
      },
    }),

    defineTool({
      name: "task_create",
      title: "Create task",
      description:
        "Create a task, optionally in a project (created if new), with owner, due date, dependencies on other tasks " +
        "and a link to the record it is about (deal, order, ticket, contact...).",
      input: {
        title: z.string().min(1),
        description: z.string().optional(),
        project: z.string().optional(),
        priority: z.enum(PRIORITIES).default("medium"),
        assignee: z.string().optional(),
        due_date: z.string().optional().describe("YYYY-MM-DD"),
        depends_on: z.array(z.number().int()).optional().describe("Task ids that must be done first"),
        related_type: z.enum(RELATED_TYPES).optional(),
        related_id: z.number().int().optional(),
      },
      handler: (a) => {
        assert(!a.related_type === !a.related_id, "related_type and related_id must be given together");
        const id = db.tx(() => {
          const id = db.run(
            `INSERT INTO tasks (project_id, title, description, priority, assignee, due_date, related_type, related_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            projectId(a.project) ?? null,
            a.title,
            a.description ?? null,
            a.priority,
            a.assignee ?? null,
            a.due_date ?? null,
            a.related_type ?? null,
            a.related_id ?? null,
          ).id;
          if (a.depends_on) addDependencies(id, a.depends_on);
          return id;
        });
        return { task: getTask(id) };
      },
    }),

    defineTool({
      name: "task_update",
      title: "Update task",
      description:
        "Update a task's status, owner, due date, priority or dependencies. Moving a task to doing/done while it still has unfinished " +
        "dependencies is refused unless force=true.",
      input: {
        task_id: z.number().int(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        assignee: z.string().optional(),
        due_date: z.string().optional(),
        project: z.string().optional(),
        add_depends_on: z.array(z.number().int()).optional(),
        remove_depends_on: z.array(z.number().int()).optional(),
        force: z.boolean().default(false),
      },
      handler: async (a) => {
        const before = findById(db, "tasks", a.task_id, "Task");
        db.tx(() => {
          if (a.add_depends_on) addDependencies(a.task_id, a.add_depends_on);
          for (const dep of a.remove_depends_on ?? []) {
            db.run("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?", a.task_id, dep);
          }
          if ((a.status === "doing" || a.status === "done") && !a.force) {
            const open = openDependencies(a.task_id);
            assert(
              open.length === 0,
              `Task #${a.task_id} is waiting on ${open.map((t) => `#${t.id} "${t.title}"`).join(", ")}. Finish those first or pass force=true.`,
            );
          }
          updateRow(db, "tasks", a.task_id, {
            title: a.title,
            description: a.description,
            status: a.status,
            priority: a.priority,
            assignee: a.assignee,
            due_date: a.due_date,
            project_id: projectId(a.project),
            completed_at: a.status && a.status !== before.status ? (a.status === "done" ? nowSql() : null) : undefined,
          });
        });
        const task = getTask(a.task_id);
        if (a.status === "done" && before.status !== "done") {
          await events.emit("task.completed", { type: "task", id: a.task_id }, `Done: ${task.title}`, { task });
          const unblocked = db.all(
            `SELECT t.id, t.title FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
             WHERE d.depends_on_id = ? AND t.status != 'done'
               AND NOT EXISTS (SELECT 1 FROM task_dependencies d2 JOIN tasks t2 ON t2.id = d2.depends_on_id
                               WHERE d2.task_id = t.id AND t2.status != 'done')`,
            a.task_id,
          );
          return { task, now_unblocked: unblocked };
        }
        return { task };
      },
    }),

    defineTool({
      name: "task_board",
      title: "Task board",
      description:
        "Board view of tasks grouped by status, with overdue, due in the next 7 days, blocked tasks and workload per assignee. " +
        "Filter by project or assignee. Completed tasks are limited to the last 14 days.",
      readOnly: true,
      input: {
        project: z.string().optional(),
        assignee: z.string().optional(),
      },
      handler: (a) => {
        const where = ["(t.status != 'done' OR t.completed_at >= datetime('now','-14 days'))"];
        const params: string[] = [];
        if (a.project) {
          where.push("p.name = ? COLLATE NOCASE");
          params.push(a.project);
        }
        if (a.assignee) {
          where.push("t.assignee = ? COLLATE NOCASE");
          params.push(a.assignee);
        }
        const ids = db.all<{ id: number }>(
          `SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE ${where.join(" AND ")}
           ORDER BY t.due_date IS NULL, t.due_date, t.id`,
          ...params,
        );
        const tasks = ids.map((r) => getTask(r.id));
        const columns: Record<string, unknown[]> = Object.fromEntries(TASK_STATUSES.map((s) => [s, []]));
        for (const t of tasks) columns[String(t.status)].push(t);
        const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
        const open = tasks.filter((t) => t.status !== "done");
        const workload: Record<string, number> = {};
        for (const t of open) workload[String(t.assignee ?? "(unassigned)")] = (workload[String(t.assignee ?? "(unassigned)")] ?? 0) + 1;
        return {
          columns,
          overdue: open.filter((t) => t.overdue),
          due_next_7_days: open.filter((t) => t.due_date && String(t.due_date) >= today() && String(t.due_date) <= week),
          blocked: open.filter((t) => t.status === "blocked" || t.blocked_by.length > 0),
          workload,
          projects: db.all(
            `SELECT p.name, p.status, SUM(t.status != 'done') AS open_tasks, SUM(t.status = 'done') AS done_tasks
             FROM projects p LEFT JOIN tasks t ON t.project_id = p.id GROUP BY p.id ORDER BY p.name`,
          ),
        };
      },
    }),
  ];
}
