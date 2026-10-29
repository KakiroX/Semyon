import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import { daysBetween, fromCents, presentAll, today } from "../util.js";
import { SLA_HOURS } from "./tickets.js";
import { STAGE_PROBABILITY } from "./crm.js";

/**
 * Analytics, next-best-actions, changelog and diagrams. Pulls the other
 * modules together the way HubSpot surfaces next actions, Shopify answers
 * performance questions, GitHub produces changelogs and Figma turns context
 * into diagrams.
 */

const SOLD = "o.status NOT IN ('pending', 'cancelled', 'refunded')";

function periodStats(ctx: Ctx, fromDaysAgo: number, toDaysAgo: number) {
  const row = ctx.db.get(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(o.total_cents), 0) AS revenue_cents,
            COALESCE(SUM(o.subtotal_cents - o.discount_cents), 0) AS net_sales_cents,
            COALESCE(SUM((SELECT SUM(oi.qty * oi.unit_cost_cents) FROM order_items oi WHERE oi.order_id = o.id)), 0) AS cogs_cents,
            COUNT(DISTINCT o.contact_id) AS customers
     FROM orders o WHERE ${SOLD}
       AND o.created_at >= datetime('now', ?) AND o.created_at < datetime('now', ?)`,
    `-${fromDaysAgo} days`,
    toDaysAgo === 0 ? "+1 day" : `-${toDaysAgo} days`,
  )!;
  const orders = Number(row.orders);
  const net = Number(row.net_sales_cents);
  const profit = net - Number(row.cogs_cents);
  return {
    orders,
    revenue: fromCents(row.revenue_cents),
    gross_profit: fromCents(profit),
    gross_margin_pct: net > 0 ? Math.round((profit / net) * 1000) / 10 : null,
    avg_order_value: orders ? fromCents(Number(row.revenue_cents) / orders) : 0,
    customers: Number(row.customers),
  };
}

function pctChange(now: number, before: number): number | null {
  return before ? Math.round(((now - before) / before) * 1000) / 10 : null;
}

export function dashboard(ctx: Ctx, days = 30) {
  const { db } = ctx;
  const current = periodStats(ctx, days, 0);
  const previous = periodStats(ctx, days * 2, days);
  const pipeline = db.all("SELECT stage, amount_cents FROM deals WHERE stage NOT IN ('won','lost')");
  return {
    period_days: days,
    currency: ctx.config.currency,
    sales: current,
    vs_previous_period: {
      revenue_change_pct: pctChange(current.revenue, previous.revenue),
      orders_change_pct: pctChange(current.orders, previous.orders),
      previous,
    },
    top_products: presentAll(
      db.all(
        `SELECT oi.sku, oi.name, SUM(oi.qty) AS units, SUM(oi.qty * oi.unit_price_cents) AS revenue_cents
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE ${SOLD} AND o.created_at >= datetime('now', ?) GROUP BY oi.sku ORDER BY revenue_cents DESC LIMIT 5`,
        `-${days} days`,
      ),
    ),
    top_customers: presentAll(
      db.all(
        `SELECT c.id, c.name, COUNT(*) AS orders, SUM(o.total_cents) AS revenue_cents
         FROM orders o JOIN contacts c ON c.id = o.contact_id
         WHERE ${SOLD} AND o.created_at >= datetime('now', ?) GROUP BY c.id ORDER BY revenue_cents DESC LIMIT 5`,
        `-${days} days`,
      ),
    ),
    by_channel: presentAll(
      db.all(
        `SELECT o.channel, COUNT(*) AS orders, SUM(o.total_cents) AS revenue_cents FROM orders o
         WHERE ${SOLD} AND o.created_at >= datetime('now', ?) GROUP BY o.channel ORDER BY revenue_cents DESC`,
        `-${days} days`,
      ),
    ),
    pipeline: {
      open_deals: pipeline.length,
      open_amount: fromCents(pipeline.reduce((s, d) => s + Number(d.amount_cents), 0)),
      weighted_forecast: fromCents(pipeline.reduce((s, d) => s + Number(d.amount_cents) * (STAGE_PROBABILITY[String(d.stage)] ?? 0), 0)),
    },
    operations: {
      orders_awaiting_payment: Number(db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'")!.n),
      orders_to_ship: Number(db.get("SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','fulfilled')")!.n),
      low_stock_skus: Number(db.get("SELECT COUNT(*) AS n FROM products WHERE status = 'active' AND stock_qty <= reorder_point")!.n),
      open_tickets: Number(db.get("SELECT COUNT(*) AS n FROM tickets WHERE status NOT IN ('resolved','closed')")!.n),
      overdue_tasks: Number(db.get("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done' AND due_date < ?", today())!.n),
      open_purchase_orders: Number(db.get("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'ordered'")!.n),
    },
  };
}

interface NextAction {
  priority: number;
  category: string;
  action: string;
  why: string;
  ref: { type: string; id: number };
}

/** Ranked to-do list built from every module (1 = most urgent). */
export function nextActions(ctx: Ctx, limit = 25): NextAction[] {
  const { db, config } = ctx;
  const out: NextAction[] = [];

  for (const t of db.all(
    `SELECT id, title, priority, created_at FROM tickets WHERE status NOT IN ('resolved','closed')
     AND priority IN ('urgent','high')`,
  )) {
    const age = Math.floor((Date.now() - new Date(String(t.created_at).replace(" ", "T") + "Z").getTime()) / 3_600_000);
    const breached = age > SLA_HOURS[String(t.priority)];
    out.push({
      priority: t.priority === "urgent" || breached ? 1 : 2,
      category: "support",
      action: `Resolve SUP-${t.id}: ${t.title}`,
      why: `${t.priority} ticket open ${age}h${breached ? " — SLA breached" : ""}`,
      ref: { type: "ticket", id: Number(t.id) },
    });
  }

  for (const o of db.all(
    `SELECT o.id, o.number, o.total_cents, COALESCE(o.paid_at, o.created_at) AS since, c.name FROM orders o
     LEFT JOIN contacts c ON c.id = o.contact_id WHERE o.status IN ('paid','fulfilled')`,
  )) {
    const age = daysBetween(String(o.since));
    out.push({
      priority: age >= 2 ? 1 : 2,
      category: "fulfillment",
      action: `Ship ${o.number} to ${o.name ?? "customer"}`,
      why: `Paid ${age} day(s) ago, ${fromCents(o.total_cents)} ${config.currency}`,
      ref: { type: "order", id: Number(o.id) },
    });
  }

  for (const o of db.all(
    `SELECT o.id, o.number, o.total_cents, o.created_at, c.name FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
     WHERE o.status = 'pending' AND o.created_at <= datetime('now', '-3 days')`,
  )) {
    out.push({
      priority: 2,
      category: "cash",
      action: `Chase payment for ${o.number} (${o.name ?? "customer"})`,
      why: `Unpaid for ${daysBetween(String(o.created_at))} days, ${fromCents(o.total_cents)} ${config.currency}; stock is reserved`,
      ref: { type: "order", id: Number(o.id) },
    });
  }

  for (const p of db.all(
    `SELECT p.id, p.sku, p.name, p.stock_qty, p.reorder_point, p.reorder_qty, s.name AS supplier,
       (SELECT COALESCE(SUM(poi.qty), 0) FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
        WHERE poi.product_id = p.id AND po.status = 'ordered') AS on_order
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.status = 'active' AND p.stock_qty <= p.reorder_point`,
  )) {
    if (Number(p.stock_qty) + Number(p.on_order) > Number(p.reorder_point)) continue;
    out.push({
      priority: Number(p.stock_qty) === 0 ? 1 : 2,
      category: "inventory",
      action: `Reorder ${p.sku} (${p.name})${p.supplier ? ` from ${p.supplier}` : ""}`,
      why: `${p.stock_qty} in stock, reorder point ${p.reorder_point}, nothing on order`,
      ref: { type: "product", id: Number(p.id) },
    });
  }

  for (const po of db.all(
    "SELECT po.id, po.expected_date, s.name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.status = 'ordered' AND po.expected_date < ?",
    today(),
  )) {
    out.push({
      priority: 2,
      category: "inventory",
      action: `Chase ${po.name} about PO-${po.id}`,
      why: `Expected ${po.expected_date}, not received`,
      ref: { type: "purchase_order", id: Number(po.id) },
    });
  }

  for (const t of db.all("SELECT id, title, due_date, assignee FROM tasks WHERE status != 'done' AND due_date <= ?", today())) {
    out.push({
      priority: String(t.due_date) < today() ? 2 : 3,
      category: "tasks",
      action: t.title as string,
      why: `${String(t.due_date) < today() ? "Overdue since" : "Due"} ${t.due_date}${t.assignee ? ` (${t.assignee})` : ""}`,
      ref: { type: "task", id: Number(t.id) },
    });
  }

  for (const d of db.all(
    `SELECT d.id, d.title, d.stage, d.amount_cents, d.next_step, d.expected_close, c.name AS contact,
       MAX(d.updated_at, COALESCE((SELECT MAX(created_at) FROM activities a WHERE a.entity_type = 'deal' AND a.entity_id = d.id), d.updated_at)) AS last_touch
     FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.stage NOT IN ('won','lost')`,
  )) {
    const idle = daysBetween(String(d.last_touch));
    const overdue = d.expected_close && String(d.expected_close) < today();
    if (idle < config.staleDealDays && !overdue) continue;
    out.push({
      priority: Number(d.amount_cents) >= 100_000 ? 2 : 3,
      category: "sales",
      action: `Follow up on "${d.title}"${d.contact ? ` with ${d.contact}` : ""}${d.next_step ? ` — next step: ${d.next_step}` : ""}`,
      why: `${d.stage}, ${fromCents(d.amount_cents)} ${config.currency}, no touch in ${idle} days${overdue ? `, close date ${d.expected_close} passed` : ""}`,
      ref: { type: "deal", id: Number(d.id) },
    });
  }

  // Repeat customers going quiet: 2+ orders, last one 60-180 days ago.
  for (const c of db.all(
    `SELECT c.id, c.name, COUNT(*) AS orders, SUM(o.total_cents) AS ltv_cents, MAX(o.created_at) AS last_order
     FROM contacts c JOIN orders o ON o.contact_id = c.id WHERE ${SOLD}
     GROUP BY c.id HAVING COUNT(*) >= 2 AND MAX(o.created_at) BETWEEN datetime('now','-180 days') AND datetime('now','-60 days')`,
  )) {
    out.push({
      priority: 3,
      category: "retention",
      action: `Re-engage ${c.name}`,
      why: `${c.orders} orders worth ${fromCents(c.ltv_cents)} ${config.currency}; last order ${daysBetween(String(c.last_order))} days ago`,
      ref: { type: "contact", id: Number(c.id) },
    });
  }

  return out.sort((a, b) => a.priority - b.priority).slice(0, limit);
}

export function insightTools(ctx: Ctx) {
  const { db } = ctx;

  return [
    defineTool({
      name: "business_dashboard",
      title: "Business dashboard",
      description:
        "Snapshot of the business: revenue, orders, gross margin and AOV vs the previous period, top products/customers, sales by channel, " +
        "pipeline forecast and operational queues (to ship, unpaid, low stock, open tickets, overdue tasks).",
      readOnly: true,
      input: { period_days: z.number().int().min(1).max(365).default(30) },
      handler: (a) => dashboard(ctx, a.period_days),
    }),

    defineTool({
      name: "next_actions",
      title: "Next best actions",
      description:
        "A ranked to-do list across the whole business: urgent tickets, orders to ship, unpaid orders, stock to reorder, late POs, overdue tasks, " +
        "stale deals and repeat customers going quiet. Priority 1 = do today.",
      readOnly: true,
      input: { limit: z.number().int().min(1).max(100).default(25) },
      handler: (a) => {
        const actions = nextActions(ctx, a.limit);
        return { count: actions.length, actions };
      },
    }),

    defineTool({
      name: "sales_report",
      title: "Sales report",
      description: "Revenue, units, gross profit and margin grouped by product, category, customer, channel, day, week or month for a date range.",
      readOnly: true,
      input: {
        group_by: z.enum(["product", "category", "customer", "channel", "day", "week", "month"]),
        from: z.string().optional().describe("YYYY-MM-DD, default 30 days ago"),
        to: z.string().optional().describe("YYYY-MM-DD inclusive, default today"),
        limit: z.number().int().min(1).max(500).default(50),
      },
      handler: (a) => {
        const from = a.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
        const to = a.to ?? today();
        const key: Record<string, string> = {
          product: "oi.sku || ' — ' || oi.name",
          category: "COALESCE(p.category, '(uncategorized)')",
          customer: "COALESCE(c.name, '(no customer)')",
          channel: "o.channel",
          day: "date(o.created_at)",
          week: "strftime('%Y-W%W', o.created_at)",
          month: "strftime('%Y-%m', o.created_at)",
        };
        const timeBased = ["day", "week", "month"].includes(a.group_by);
        const rows = db.all(
          `SELECT ${key[a.group_by]} AS grp, COUNT(DISTINCT o.id) AS orders, SUM(oi.qty) AS units,
                  SUM(oi.qty * oi.unit_price_cents) AS revenue_cents, SUM(oi.qty * (oi.unit_price_cents - oi.unit_cost_cents)) AS gross_profit_cents
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN contacts c ON c.id = o.contact_id
           WHERE ${SOLD} AND date(o.created_at) BETWEEN ? AND ?
           GROUP BY grp ORDER BY ${timeBased ? "grp" : "revenue_cents DESC"} LIMIT ?`,
          from,
          to,
          a.limit,
        );
        const out = presentAll(rows).map((r) => ({
          [a.group_by]: r.grp,
          orders: r.orders,
          units: r.units,
          revenue: r.revenue,
          gross_profit: r.gross_profit,
          margin_pct: Number(r.revenue) ? Math.round((Number(r.gross_profit) / Number(r.revenue)) * 1000) / 10 : null,
        }));
        const total = out.reduce((s, r) => s + Number(r.revenue), 0);
        return { from, to, note: "Revenue here is line-item sales before order discounts, shipping and tax.", total_revenue: Math.round(total * 100) / 100, rows: out };
      },
    }),

    defineTool({
      name: "activity_feed",
      title: "Business changelog",
      description:
        "Chronological log of everything that happened (orders, stock moves, deal changes, tickets, tasks, automations) — like a commit history " +
        "for the business. Use for 'what happened this week?' or to write an update.",
      readOnly: true,
      input: {
        since: z.string().optional().describe("YYYY-MM-DD, default 7 days ago"),
        type_prefix: z.string().optional().describe("e.g. 'order', 'deal', 'inventory.low_stock'"),
        entity_type: z.string().optional(),
        entity_id: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      handler: (a) => {
        const where = ["created_at >= ?"];
        const params: (string | number)[] = [a.since ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)];
        if (a.type_prefix) where.push("type LIKE ?"), params.push(`${a.type_prefix}%`);
        if (a.entity_type) where.push("entity_type = ?"), params.push(a.entity_type);
        if (a.entity_id) where.push("entity_id = ?"), params.push(a.entity_id);
        const events = db.all(
          `SELECT id, type, entity_type, entity_id, summary, created_at FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
          ...params,
          a.limit,
        );
        const counts: Record<string, number> = {};
        for (const e of events) counts[String(e.type)] = (counts[String(e.type)] ?? 0) + 1;
        return { since: params[0], counts_by_type: counts, events };
      },
    }),

    defineTool({
      name: "diagram",
      title: "Generate diagram",
      description:
        "Generate a Mermaid diagram from live data: `pipeline` (deal funnel by stage), `order_flow` (order lifecycle with counts per status), " +
        "`task_dependencies` (task graph for a project), `supply_chain` (suppliers → products with stock levels).",
      readOnly: true,
      input: {
        kind: z.enum(["pipeline", "order_flow", "task_dependencies", "supply_chain"]),
        project: z.string().optional().describe("For task_dependencies"),
      },
      handler: (a) => ({ kind: a.kind, format: "mermaid", diagram: diagram(ctx, a.kind, a.project) }),
    }),
  ];
}

const esc = (s: unknown) => String(s ?? "").replace(/["\n]/g, "'");

function diagram(ctx: Ctx, kind: string, project?: string): string {
  const { db, config } = ctx;
  switch (kind) {
    case "pipeline": {
      const stages = ["lead", "qualified", "quote_sent", "negotiation", "won", "lost"];
      const rows = new Map(
        db.all("SELECT stage, COUNT(*) AS n, SUM(amount_cents) AS amt FROM deals GROUP BY stage").map((r) => [String(r.stage), r]),
      );
      const label = (s: string) => {
        const r = rows.get(s);
        return `${s}<br/>${r ? r.n : 0} deals · ${fromCents(r?.amt ?? 0)} ${config.currency}`;
      };
      const lines = ["flowchart LR"];
      for (const s of stages) lines.push(`  ${s}["${label(s)}"]`);
      lines.push("  lead --> qualified --> quote_sent --> negotiation --> won", "  negotiation -.-> lost", "  quote_sent -.-> lost");
      lines.push("  style won fill:#d4f7d4", "  style lost fill:#f7d4d4");
      return lines.join("\n");
    }
    case "order_flow": {
      const counts = new Map(db.all("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").map((r) => [String(r.status), Number(r.n)]));
      const n = (s: string) => counts.get(s) ?? 0;
      return [
        "stateDiagram-v2",
        `  [*] --> pending`,
        `  pending: pending (${n("pending")})`,
        `  paid: paid (${n("paid")})`,
        `  fulfilled: fulfilled (${n("fulfilled")})`,
        `  shipped: shipped (${n("shipped")})`,
        `  delivered: delivered (${n("delivered")})`,
        `  cancelled: cancelled (${n("cancelled")})`,
        `  refunded: refunded (${n("refunded")})`,
        "  pending --> paid",
        "  pending --> cancelled",
        "  paid --> fulfilled",
        "  paid --> shipped",
        "  paid --> cancelled",
        "  fulfilled --> shipped",
        "  shipped --> delivered",
        "  paid --> refunded",
        "  shipped --> refunded",
        "  delivered --> refunded",
        "  delivered --> [*]",
      ].join("\n");
    }
    case "task_dependencies": {
      const tasks = project
        ? db.all("SELECT t.id, t.title, t.status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.name = ? COLLATE NOCASE", project)
        : db.all("SELECT id, title, status FROM tasks WHERE status != 'done' OR completed_at >= datetime('now','-14 days')");
      const ids = new Set(tasks.map((t) => Number(t.id)));
      const lines = ["flowchart TD"];
      for (const t of tasks) lines.push(`  T${t.id}["#${t.id} ${esc(t.title)}<br/>(${t.status})"]:::${t.status}`);
      for (const d of db.all("SELECT task_id, depends_on_id FROM task_dependencies")) {
        if (ids.has(Number(d.task_id)) && ids.has(Number(d.depends_on_id))) lines.push(`  T${d.depends_on_id} --> T${d.task_id}`);
      }
      lines.push(
        "  classDef done fill:#d4f7d4",
        "  classDef doing fill:#d4e4f7",
        "  classDef blocked fill:#f7d4d4",
        "  classDef todo fill:#eeeeee",
      );
      return lines.join("\n");
    }
    case "supply_chain": {
      const lines = ["flowchart LR"];
      const products = db.all(
        "SELECT p.id, p.sku, p.stock_qty, p.reorder_point, p.supplier_id, s.name AS supplier FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.status = 'active'",
      );
      const suppliers = new Map<number, string>();
      for (const p of products) if (p.supplier_id) suppliers.set(Number(p.supplier_id), String(p.supplier));
      for (const [id, name] of suppliers) lines.push(`  S${id}[["${esc(name)}"]]`);
      for (const p of products) {
        const low = Number(p.stock_qty) <= Number(p.reorder_point);
        lines.push(`  P${p.id}["${esc(p.sku)}<br/>stock ${p.stock_qty}"]${low ? ":::low" : ""}`);
        if (p.supplier_id) lines.push(`  S${p.supplier_id} --> P${p.id}`);
      }
      lines.push("  classDef low fill:#f7d4d4");
      return lines.join("\n");
    }
    default:
      return "";
  }
}

