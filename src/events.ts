import type { Db, Row } from "./db.js";
import { logActivity, parseJson } from "./util.js";

/**
 * Event log + automation engine.
 *
 * Every state change emits an event. Events form the business changelog
 * (GitHub-style history) and drive user-defined automations (Zapier-style
 * "when X happens, if conditions match, do Y").
 */

export const EVENT_TYPES: Record<string, string> = {
  "product.created": "A product was added to the catalog. Data: product",
  "product.updated": "A product's details changed. Data: product, changes",
  "inventory.adjusted": "Stock was adjusted. Data: product, delta, reason",
  "inventory.low_stock": "Stock fell to or below the reorder point. Data: product",
  "purchase_order.created": "A purchase order was placed with a supplier. Data: purchase_order, supplier",
  "purchase_order.received": "A purchase order was received into stock. Data: purchase_order, supplier",
  "contact.created": "A new contact/lead was added. Data: contact",
  "deal.created": "A new deal was opened. Data: deal, contact",
  "deal.stage_changed": "A deal moved stage. Data: deal, from, to",
  "order.created": "A sales order was placed. Data: order, contact, items",
  "order.status_changed": "An order changed status. Data: order, from, to, contact",
  "ticket.created": "A support/RMA ticket was opened. Data: ticket, contact",
  "ticket.status_changed": "A ticket changed status. Data: ticket, from, to",
  "task.completed": "A task was marked done. Data: task",
  "meeting.logged": "A meeting was recorded. Data: meeting, action_items",
};

export interface Condition {
  field: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in";
  value: unknown;
}

export type Action =
  | { type: "create_task"; title: string; description?: string; priority?: string; assignee?: string; due_in_days?: number; project?: string }
  | { type: "create_ticket"; title: string; description?: string; priority?: string; ticket_type?: string }
  | { type: "log_activity"; body: string }
  | { type: "webhook"; url: string; payload?: Record<string, unknown> };

export interface EntityRef {
  type: string;
  id: number;
}

export interface AutomationResult {
  automation_id: number;
  name: string;
  status: "ok" | "error";
  results: string[];
}

export interface EmitResult {
  event_id: number;
  automations: AutomationResult[];
}

export interface EventBusOptions {
  fetch?: typeof fetch;
  webhookTimeoutMs?: number;
}

export function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replaces {{path.to.value}} placeholders with values from the event data. */
export function render(template: string, data: unknown): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = getPath(data, path);
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

function renderDeep(value: unknown, data: unknown): unknown {
  if (typeof value === "string") return render(value, data);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, data));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, data)]));
  }
  return value;
}

export function matches(conditions: Condition[], data: unknown): boolean {
  return conditions.every((c) => {
    const actual = getPath(data, c.field);
    const expected = c.value;
    switch (c.op) {
      case "eq":
        return String(actual) === String(expected);
      case "neq":
        return String(actual) !== String(expected);
      case "gt":
        return Number(actual) > Number(expected);
      case "gte":
        return Number(actual) >= Number(expected);
      case "lt":
        return Number(actual) < Number(expected);
      case "lte":
        return Number(actual) <= Number(expected);
      case "contains":
        return Array.isArray(actual)
          ? actual.map(String).includes(String(expected))
          : String(actual ?? "").toLowerCase().includes(String(expected).toLowerCase());
      case "in":
        return Array.isArray(expected) && expected.map(String).includes(String(actual));
      default:
        return false;
    }
  });
}

export class EventBus {
  private readonly fetchImpl: typeof fetch;
  private readonly webhookTimeoutMs: number;

  constructor(
    private readonly db: Db,
    opts: EventBusOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.webhookTimeoutMs = opts.webhookTimeoutMs ?? 10_000;
  }

  /** Records an event and runs the automations listening for it. */
  async emit(type: string, entity: EntityRef | null, summary: string, data: Record<string, unknown>): Promise<EmitResult> {
    const eventId = this.db.run(
      "INSERT INTO events (type, entity_type, entity_id, summary, data) VALUES (?, ?, ?, ?, ?)",
      type,
      entity?.type ?? null,
      entity?.id ?? null,
      summary,
      JSON.stringify(data),
    ).id;

    const automations = this.db.all("SELECT * FROM automations WHERE enabled = 1 AND trigger_event = ? ORDER BY id", type);
    const results: AutomationResult[] = [];
    for (const automation of automations) {
      const conditions = parseJson<Condition[]>(automation.conditions, []);
      if (!matches(conditions, data)) continue;
      results.push(await this.run(automation, eventId, entity, { event: { type, summary }, ...data }));
    }
    return { event_id: eventId, automations: results };
  }

  private async run(automation: Row, eventId: number, entity: EntityRef | null, data: Record<string, unknown>): Promise<AutomationResult> {
    const actions = parseJson<Action[]>(automation.actions, []);
    const out: string[] = [];
    let status: "ok" | "error" = "ok";
    for (const action of actions) {
      try {
        out.push(await this.execute(action, entity, data));
      } catch (e) {
        status = "error";
        out.push(`${action.type} failed: ${(e as Error).message}`);
      }
    }
    const id = Number(automation.id);
    this.db.run(
      "INSERT INTO automation_runs (automation_id, event_id, status, result) VALUES (?, ?, ?, ?)",
      id,
      eventId,
      status,
      JSON.stringify(out),
    );
    this.db.run("UPDATE automations SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?", id);
    return { automation_id: id, name: String(automation.name), status, results: out };
  }

  private async execute(action: Action, entity: EntityRef | null, data: Record<string, unknown>): Promise<string> {
    switch (action.type) {
      case "create_task": {
        let projectId: number | null = null;
        if (action.project) {
          const project = this.db.get<{ id: number }>("SELECT id FROM projects WHERE name = ? COLLATE NOCASE", action.project);
          projectId =
            project?.id ?? this.db.run("INSERT INTO projects (name) VALUES (?)", action.project).id;
        }
        const due =
          action.due_in_days !== undefined
            ? new Date(Date.now() + action.due_in_days * 86_400_000).toISOString().slice(0, 10)
            : null;
        const id = this.db.run(
          `INSERT INTO tasks (project_id, title, description, priority, assignee, due_date, related_type, related_id, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'automation')`,
          projectId,
          render(action.title, data),
          action.description ? render(action.description, data) : null,
          action.priority ?? "medium",
          action.assignee ?? null,
          due,
          entity?.type ?? null,
          entity?.id ?? null,
        ).id;
        return `created task #${id}`;
      }
      case "create_ticket": {
        const contactId = getPath(data, "contact.id") ?? null;
        const orderId = getPath(data, "order.id") ?? null;
        const productId = getPath(data, "product.id") ?? null;
        const id = this.db.run(
          "INSERT INTO tickets (title, description, type, priority, contact_id, order_id, product_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          render(action.title, data),
          action.description ? render(action.description, data) : null,
          action.ticket_type ?? "support",
          action.priority ?? "medium",
          contactId as number | null,
          orderId as number | null,
          productId as number | null,
        ).id;
        return `created ticket #${id}`;
      }
      case "log_activity": {
        if (!entity) return "skipped log_activity: event has no entity";
        const id = logActivity(this.db, entity.type, entity.id, "automation", render(action.body, data));
        return `logged activity #${id} on ${entity.type} #${entity.id}`;
      }
      case "webhook": {
        const body = action.payload ? renderDeep(action.payload, data) : data;
        const res = await this.fetchImpl(action.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "semyon-mcp" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.webhookTimeoutMs),
        });
        if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
        return `webhook delivered (HTTP ${res.status})`;
      }
      default:
        throw new Error(`unknown action type ${(action as { type: string }).type}`);
    }
  }
}
