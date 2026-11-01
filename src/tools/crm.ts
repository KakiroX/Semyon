import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import type { Row } from "../db.js";
import {
  assert,
  daysBetween,
  findById,
  findContact,
  fromCents,
  parseJson,
  present,
  presentAll,
  timeline,
  toCents,
  updateRow,
  logActivity,
  nowSql,
} from "../util.js";

/**
 * CRM — modeled on the HubSpot and Salesforce MCPs: live context on contacts,
 * companies and the deal pipeline so Claude can summarize accounts, draft
 * follow-ups and surface the next action.
 */

export const DEAL_STAGES = ["lead", "qualified", "quote_sent", "negotiation", "won", "lost"] as const;
export const STAGE_PROBABILITY: Record<string, number> = {
  lead: 0.1,
  qualified: 0.25,
  quote_sent: 0.5,
  negotiation: 0.75,
  won: 1,
  lost: 0,
};
const CONTACT_TYPES = ["lead", "customer", "partner", "vendor"] as const;
const ENTITY_TYPES = ["contact", "company", "deal", "order", "ticket", "product", "task"] as const;

function presentContact(row: Row | undefined) {
  return present(row, ["tags"]);
}

function companyId(ctx: Ctx, name?: string): number | undefined {
  if (!name) return undefined;
  const existing = ctx.db.get<{ id: number }>("SELECT id FROM companies WHERE name = ? COLLATE NOCASE", name);
  return existing?.id ?? ctx.db.run("INSERT INTO companies (name) VALUES (?)", name).id;
}

/** Latest of the deal's own update and any activity logged against it. */
const DEAL_LAST_TOUCH = `MAX(d.updated_at, COALESCE((SELECT MAX(created_at) FROM activities a
  WHERE a.entity_type = 'deal' AND a.entity_id = d.id), d.updated_at))`;

export function crmTools(ctx: Ctx) {
  const { db, events } = ctx;

  function getDeal(id: number) {
    const d = db.get(
      `SELECT d.*, c.name AS contact_name, c.email AS contact_email, co.name AS company_name, ${DEAL_LAST_TOUCH} AS last_touch
       FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN companies co ON co.id = d.company_id WHERE d.id = ?`,
      id,
    );
    assert(d, `Deal #${id} not found`);
    const out = present(d)!;
    out.probability = STAGE_PROBABILITY[String(d.stage)];
    out.weighted_amount = fromCents(Number(d.amount_cents) * (STAGE_PROBABILITY[String(d.stage)] ?? 0));
    out.days_since_touch = daysBetween(String(d.last_touch));
    return out;
  }

  return [
    defineTool({
      name: "company_upsert",
      title: "Create or update company",
      description: "Create a company/account, or update it if one with this name exists.",
      input: {
        name: z.string().min(1),
        domain: z.string().optional(),
        industry: z.string().optional(),
        notes: z.string().optional(),
      },
      handler: (a) => {
        const id = companyId(ctx, a.name)!;
        updateRow(db, "companies", id, { domain: a.domain, industry: a.industry, notes: a.notes }, false);
        return { company: findById(db, "companies", id) };
      },
    }),

    defineTool({
      name: "contact_upsert",
      title: "Create or update contact",
      description:
        "Create a contact (lead/customer/partner/vendor) or update an existing one matched by contact_id or email. " +
        "Companies are created on the fly. Tags are merged with existing tags.",
      input: {
        contact_id: z.number().int().optional(),
        email: z.string().optional(),
        name: z.string().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        type: z.enum(CONTACT_TYPES).optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
      handler: async (a) => {
        const existing =
          (a.contact_id && db.get("SELECT * FROM contacts WHERE id = ?", a.contact_id)) ||
          (a.email && db.get("SELECT * FROM contacts WHERE email = ? COLLATE NOCASE", a.email)) ||
          undefined;
        assert(!a.contact_id || existing, `Contact #${a.contact_id} not found`);
        const coId = companyId(ctx, a.company);
        if (existing) {
          const id = Number(existing.id);
          const tags = a.tags ? [...new Set([...parseJson<string[]>(existing.tags, []), ...a.tags])] : undefined;
          updateRow(db, "contacts", id, {
            email: a.email,
            name: a.name,
            phone: a.phone,
            company_id: coId,
            type: a.type,
            tags,
            notes: a.notes,
          });
          return { action: "updated", contact: presentContact(findById(db, "contacts", id)) };
        }
        assert(a.name, "name is required when creating a contact");
        const id = db.run(
          "INSERT INTO contacts (company_id, name, email, phone, type, tags, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
          coId ?? null,
          a.name,
          a.email ?? null,
          a.phone ?? null,
          a.type ?? "lead",
          JSON.stringify(a.tags ?? []),
          a.notes ?? null,
        ).id;
        const contact = presentContact(findById(db, "contacts", id));
        await events.emit("contact.created", { type: "contact", id }, `New ${a.type ?? "lead"}: ${a.name}`, { contact });
        return { action: "created", contact };
      },
    }),

    defineTool({
      name: "contact_get",
      title: "Customer 360 view",
      description:
        "Everything about one contact: company, lifetime value, orders, open deals, tickets, meetings, open tasks and the activity timeline. " +
        "Use before drafting a follow-up or summarizing an account.",
      readOnly: true,
      input: { contact_id: z.number().int().optional(), email: z.string().optional() },
      handler: (a) => {
        const c = findContact(db, a);
        const id = Number(c.id);
        const stats = db.get(
          `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_cents), 0) AS lifetime_value_cents,
                  MAX(created_at) AS last_order_at, MIN(created_at) AS first_order_at
           FROM orders WHERE contact_id = ? AND status NOT IN ('cancelled', 'refunded', 'pending')`,
          id,
        );
        return {
          contact: presentContact(c),
          company: c.company_id ? findById(db, "companies", Number(c.company_id)) : null,
          stats: {
            ...present(stats),
            days_since_last_order: stats?.last_order_at ? daysBetween(String(stats.last_order_at)) : null,
            avg_order_value: Number(stats?.order_count) ? fromCents(Number(stats!.lifetime_value_cents) / Number(stats!.order_count)) : 0,
          },
          recent_orders: presentAll(
            db.all("SELECT id, number, status, total_cents, created_at FROM orders WHERE contact_id = ? ORDER BY id DESC LIMIT 10", id),
          ),
          deals: db.all<{ id: number }>("SELECT id FROM deals WHERE contact_id = ? ORDER BY id DESC", id).map((d) => getDeal(d.id)),
          tickets: db.all("SELECT id, title, type, priority, status, created_at FROM tickets WHERE contact_id = ? ORDER BY id DESC LIMIT 10", id),
          meetings: db.all("SELECT id, title, held_at, summary FROM meetings WHERE contact_id = ? ORDER BY held_at DESC LIMIT 5", id),
          open_tasks: db.all(
            "SELECT id, title, status, due_date FROM tasks WHERE related_type = 'contact' AND related_id = ? AND status != 'done'",
            id,
          ),
          timeline: timeline(db, "contact", id),
        };
      },
    }),

    defineTool({
      name: "contact_search",
      title: "Search contacts",
      description: "Find contacts by text (name, email, phone, company), type or tag.",
      readOnly: true,
      input: {
        query: z.string().optional(),
        type: z.enum(CONTACT_TYPES).optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      handler: (a) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (a.query) {
          const q = `%${a.query}%`;
          where.push("(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR co.name LIKE ?)");
          params.push(q, q, q, q);
        }
        if (a.type) {
          where.push("c.type = ?");
          params.push(a.type);
        }
        if (a.tag) {
          where.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ? COLLATE NOCASE)");
          params.push(a.tag);
        }
        const rows = db.all(
          `SELECT c.*, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY c.name LIMIT ?`,
          ...params,
          a.limit,
        );
        return { count: rows.length, contacts: rows.map(presentContact) };
      },
    }),

    defineTool({
      name: "deal_create",
      title: "Create deal",
      description: "Open a sales opportunity (e.g. a bulk quote for 50 dev boards) linked to a contact.",
      input: {
        title: z.string().min(1),
        contact_id: z.number().int().optional(),
        email: z.string().optional().describe("Contact email (alternative to contact_id)"),
        amount: z.number().nonnegative().default(0),
        stage: z.enum(DEAL_STAGES).default("lead"),
        expected_close: z.string().optional().describe("YYYY-MM-DD"),
        next_step: z.string().optional(),
      },
      handler: async (a) => {
        const contact = a.contact_id || a.email ? findContact(db, a) : undefined;
        const id = db.run(
          "INSERT INTO deals (title, contact_id, company_id, stage, amount_cents, expected_close, next_step) VALUES (?, ?, ?, ?, ?, ?, ?)",
          a.title,
          (contact?.id as number | undefined) ?? null,
          (contact?.company_id as number | undefined) ?? null,
          a.stage,
          toCents(a.amount),
          a.expected_close ?? null,
          a.next_step ?? null,
        ).id;
        const deal = getDeal(id);
        await events.emit("deal.created", { type: "deal", id }, `New deal: ${a.title}`, { deal, contact: presentContact(contact) ?? null });
        return { deal };
      },
    }),

    defineTool({
      name: "deal_update",
      title: "Update deal",
      description: "Move a deal through the pipeline or change its amount, close date or next step. lost_reason is required when marking lost.",
      input: {
        deal_id: z.number().int(),
        stage: z.enum(DEAL_STAGES).optional(),
        amount: z.number().nonnegative().optional(),
        expected_close: z.string().optional(),
        next_step: z.string().optional(),
        lost_reason: z.string().optional(),
        note: z.string().optional().describe("Logged on the deal timeline"),
      },
      handler: async (a) => {
        const before = findById(db, "deals", a.deal_id, "Deal");
        const stageChanged = a.stage !== undefined && a.stage !== before.stage;
        if (a.stage === "lost") assert(a.lost_reason || before.lost_reason, "lost_reason is required when marking a deal lost");
        updateRow(db, "deals", a.deal_id, {
          stage: a.stage,
          amount_cents: a.amount !== undefined ? toCents(a.amount) : undefined,
          expected_close: a.expected_close,
          next_step: a.next_step,
          lost_reason: a.lost_reason,
          closed_at: stageChanged ? (a.stage === "won" || a.stage === "lost" ? nowSql() : null) : undefined,
        });
        if (a.note) logActivity(db, "deal", a.deal_id, "note", a.note);
        const deal = getDeal(a.deal_id);
        if (stageChanged) {
          logActivity(db, "deal", a.deal_id, "system", `Stage ${before.stage} → ${a.stage}`);
          await events.emit("deal.stage_changed", { type: "deal", id: a.deal_id }, `${before.title}: ${before.stage} → ${a.stage}`, {
            deal,
            from: before.stage,
            to: a.stage,
          });
        }
        return { deal };
      },
    }),

    defineTool({
      name: "deal_pipeline",
      title: "Deal pipeline",
      description:
        "Pipeline board: open deals per stage with totals, weighted forecast, deals closing soon, overdue close dates and stale deals " +
        "(no touch in N days). Also win rate over the last 90 days.",
      readOnly: true,
      input: { stale_after_days: z.number().int().positive().optional() },
      handler: (a) => {
        const staleDays = a.stale_after_days ?? ctx.config.staleDealDays;
        const openIds = db.all<{ id: number }>("SELECT id FROM deals WHERE stage NOT IN ('won','lost') ORDER BY expected_close IS NULL, expected_close");
        const open = openIds.map((d) => getDeal(d.id));
        const stages: Record<string, { count: number; amount: number; weighted: number; deals: Row[] }> = {};
        for (const s of DEAL_STAGES.filter((s) => s !== "won" && s !== "lost")) stages[s] = { count: 0, amount: 0, weighted: 0, deals: [] };
        for (const d of open) {
          const s = stages[String(d.stage)];
          s.count++;
          s.amount += Number(d.amount);
          s.weighted += Number(d.weighted_amount);
          s.deals.push({ id: d.id, title: d.title, contact: d.contact_name, amount: d.amount, expected_close: d.expected_close, next_step: d.next_step });
        }
        const todayStr = new Date().toISOString().slice(0, 10);
        const in14 = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
        const closed = db.get<{ won: number; lost: number; won_cents: number }>(
          `SELECT SUM(stage = 'won') AS won, SUM(stage = 'lost') AS lost, COALESCE(SUM(CASE WHEN stage = 'won' THEN amount_cents END), 0) AS won_cents
           FROM deals WHERE closed_at >= datetime('now', '-90 days')`,
        )!;
        const wonLost = Number(closed.won ?? 0) + Number(closed.lost ?? 0);
        const round = (n: number) => Math.round(n * 100) / 100;
        return {
          totals: {
            open_deals: open.length,
            open_amount: round(open.reduce((s, d) => s + Number(d.amount), 0)),
            weighted_forecast: round(open.reduce((s, d) => s + Number(d.weighted_amount), 0)),
          },
          stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, { ...v, amount: round(v.amount), weighted: round(v.weighted) }])),
          closing_next_14_days: open.filter((d) => d.expected_close && String(d.expected_close) >= todayStr && String(d.expected_close) <= in14),
          overdue_close_date: open.filter((d) => d.expected_close && String(d.expected_close) < todayStr),
          stale: open.filter((d) => Number(d.days_since_touch) >= staleDays),
          last_90_days: {
            won: Number(closed.won ?? 0),
            lost: Number(closed.lost ?? 0),
            won_amount: fromCents(closed.won_cents),
            win_rate: wonLost ? Math.round((Number(closed.won) / wonLost) * 100) / 100 : null,
          },
        };
      },
    }),

    defineTool({
      name: "deal_get",
      title: "Get deal",
      description: "One deal with its contact, related meetings, open tasks and timeline.",
      readOnly: true,
      input: { deal_id: z.number().int() },
      handler: (a) => ({
        deal: getDeal(a.deal_id),
        meetings: db.all("SELECT id, title, held_at, summary FROM meetings WHERE deal_id = ? ORDER BY held_at DESC", a.deal_id),
        open_tasks: db.all(
          "SELECT id, title, status, due_date FROM tasks WHERE related_type = 'deal' AND related_id = ? AND status != 'done'",
          a.deal_id,
        ),
        orders: presentAll(db.all("SELECT id, number, status, total_cents FROM orders WHERE deal_id = ?", a.deal_id)),
        timeline: timeline(db, "deal", a.deal_id),
      }),
    }),

    defineTool({
      name: "activity_log",
      title: "Log activity",
      description:
        "Record a call, email, note or meeting on a contact, company, deal, order, ticket, product or task timeline. " +
        "Logging on a deal counts as touching it (it won't show as stale).",
      input: {
        entity_type: z.enum(ENTITY_TYPES),
        entity_id: z.number().int(),
        kind: z.enum(["note", "call", "email", "meeting"]),
        body: z.string().min(1),
      },
      handler: (a) => {
        const table = a.entity_type === "company" ? "companies" : `${a.entity_type}s`;
        findById(db, table, a.entity_id, a.entity_type);
        const id = logActivity(db, a.entity_type, a.entity_id, a.kind, a.body);
        return { activity_id: id, timeline: timeline(db, a.entity_type, a.entity_id, 5) };
      },
    }),
  ];
}
