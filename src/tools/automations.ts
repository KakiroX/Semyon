import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import { EVENT_TYPES, matches, type Condition } from "../events.js";
import type { Row } from "../db.js";
import { assert, findById, parseJson } from "../util.js";

/**
 * Automations — modeled on the Zapier MCP: "when this happens, if these
 * conditions hold, do that". Actions can create tasks or tickets, log to a
 * timeline, or POST to a webhook (a Zapier/Make/n8n catch hook, Slack
 * incoming webhook, etc.) to reach apps without a native integration.
 */

const eventEnum = z.enum(Object.keys(EVENT_TYPES) as [string, ...string[]]);

const condition = z.object({
  field: z.string().describe("Dotted path into the event data, e.g. 'order.total', 'product.stock_qty', 'to'"),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
});

const action = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_task"),
    title: z.string().describe("Supports {{placeholders}}, e.g. 'Reorder {{product.sku}}'"),
    description: z.string().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    assignee: z.string().optional(),
    due_in_days: z.number().int().nonnegative().optional(),
    project: z.string().optional(),
  }),
  z.object({
    type: z.literal("create_ticket"),
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    ticket_type: z.enum(["support", "rma", "warranty", "question", "complaint"]).optional(),
  }),
  z.object({ type: z.literal("log_activity"), body: z.string() }),
  z.object({
    type: z.literal("webhook"),
    url: z.url({ protocol: /^https?$/ }),
    payload: z.record(z.string(), z.unknown()).optional().describe("Custom JSON body; string values support {{placeholders}}. Defaults to the full event data."),
  }),
]);

export function automationTools(ctx: Ctx) {
  const { db } = ctx;

  function getAutomation(id: number): Row {
    const a = findById(db, "automations", id, "Automation");
    return { ...a, enabled: !!a.enabled, conditions: parseJson(a.conditions, []), actions: parseJson(a.actions, []) };
  }

  return [
    defineTool({
      name: "automation_create",
      title: "Create automation",
      description:
        "Create a rule that runs when a business event happens. Example: on inventory.low_stock create a task 'Reorder {{product.sku}}' " +
        "due in 1 day; on order.created with order.total gte 500 POST to a Slack webhook; on ticket.created with ticket.priority eq urgent " +
        "create a task for the owner. Use automation_list to see every event type and what data it carries.",
      input: {
        name: z.string().min(1),
        trigger_event: eventEnum,
        conditions: z.array(condition).default([]),
        actions: z.array(action).min(1),
        enabled: z.boolean().default(true),
      },
      handler: (a) => {
        const id = db.run(
          "INSERT INTO automations (name, trigger_event, conditions, actions, enabled) VALUES (?, ?, ?, ?, ?)",
          a.name,
          a.trigger_event,
          JSON.stringify(a.conditions),
          JSON.stringify(a.actions),
          a.enabled ? 1 : 0,
        ).id;
        return { automation: getAutomation(id) };
      },
    }),

    defineTool({
      name: "automation_list",
      title: "List automations",
      description: "All automations with run counts, plus the catalog of event types you can trigger on and the data each one carries.",
      readOnly: true,
      input: {},
      handler: () => ({
        automations: db.all<{ id: number }>("SELECT id FROM automations ORDER BY id").map((r) => getAutomation(r.id)),
        event_types: EVENT_TYPES,
      }),
    }),

    defineTool({
      name: "automation_update",
      title: "Update automation",
      description: "Enable/disable an automation or replace its name, conditions or actions.",
      input: {
        automation_id: z.number().int(),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        conditions: z.array(condition).optional(),
        actions: z.array(action).min(1).optional(),
      },
      handler: (a) => {
        findById(db, "automations", a.automation_id, "Automation");
        const sets: string[] = [];
        const values: (string | number)[] = [];
        if (a.name !== undefined) sets.push("name = ?"), values.push(a.name);
        if (a.enabled !== undefined) sets.push("enabled = ?"), values.push(a.enabled ? 1 : 0);
        if (a.conditions !== undefined) sets.push("conditions = ?"), values.push(JSON.stringify(a.conditions));
        if (a.actions !== undefined) sets.push("actions = ?"), values.push(JSON.stringify(a.actions));
        if (sets.length) db.run(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`, ...values, a.automation_id);
        return { automation: getAutomation(a.automation_id) };
      },
    }),

    defineTool({
      name: "automation_delete",
      title: "Delete automation",
      description: "Permanently delete an automation and its run history. Requires confirm=true. Prefer automation_update enabled=false to pause.",
      destructive: true,
      input: { automation_id: z.number().int(), confirm: z.literal(true) },
      handler: (a) => {
        const automation = getAutomation(a.automation_id);
        db.run("DELETE FROM automations WHERE id = ?", a.automation_id);
        return { deleted: { id: automation.id, name: automation.name } };
      },
    }),

    defineTool({
      name: "automation_test",
      title: "Dry-run automation",
      description:
        "Check whether an automation's conditions would match, without running its actions. Uses `sample_data` if given, " +
        "otherwise the most recent real events of its trigger type.",
      readOnly: true,
      input: {
        automation_id: z.number().int(),
        sample_data: z.record(z.string(), z.unknown()).optional(),
      },
      handler: (a) => {
        const automation = getAutomation(a.automation_id);
        const conditions = automation.conditions as Condition[];
        if (a.sample_data) return { automation: automation.name, would_run: matches(conditions, a.sample_data) };
        const recent = db.all("SELECT id, summary, data, created_at FROM events WHERE type = ? ORDER BY id DESC LIMIT 10", String(automation.trigger_event));
        assert(recent.length > 0, `No ${automation.trigger_event} events yet; pass sample_data to test.`);
        return {
          automation: automation.name,
          recent_events: recent.map((e) => ({
            event_id: e.id,
            summary: e.summary,
            created_at: e.created_at,
            would_run: matches(conditions, parseJson(e.data, {})),
          })),
        };
      },
    }),

    defineTool({
      name: "automation_history",
      title: "Automation run history",
      description: "Recent automation runs with their results and errors.",
      readOnly: true,
      input: {
        automation_id: z.number().int().optional(),
        errors_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(25),
      },
      handler: (a) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (a.automation_id) where.push("r.automation_id = ?"), params.push(a.automation_id);
        if (a.errors_only) where.push("r.status = 'error'");
        const rows = db.all(
          `SELECT r.id, r.automation_id, au.name, r.status, r.result, r.created_at, e.summary AS event
           FROM automation_runs r JOIN automations au ON au.id = r.automation_id LEFT JOIN events e ON e.id = r.event_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.id DESC LIMIT ?`,
          ...params,
          a.limit,
        );
        return { runs: rows.map((r) => ({ ...r, result: parseJson(r.result, []) })) };
      },
    }),
  ];
}
