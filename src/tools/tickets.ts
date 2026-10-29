import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import type { Row } from "../db.js";
import { assert, findById, findContact, findOrder, findProduct, logActivity, nowSql, timeline, updateRow } from "../util.js";

/**
 * Support, returns and warranty tickets — modeled on the Atlassian (Jira) MCP:
 * a ticket workflow Claude can triage, comment on and move along.
 */

const TICKET_TYPES = ["support", "rma", "warranty", "question", "complaint"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const STATUSES = ["open", "in_progress", "waiting_customer", "waiting_supplier", "resolved", "closed"] as const;
/** Target hours to resolve, per priority. */
export const SLA_HOURS: Record<string, number> = { urgent: 4, high: 24, medium: 72, low: 168 };
const PRIORITY_RANK = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export function ticketTools(ctx: Ctx) {
  const { db, events } = ctx;

  function decorate(t: Row): Row & { sla_breached: boolean } {
    const ageHours = Math.floor((Date.now() - new Date(String(t.created_at).replace(" ", "T") + "Z").getTime()) / 3_600_000);
    const open = !["resolved", "closed"].includes(String(t.status));
    return { key: `SUP-${t.id}`, ...t, age_hours: ageHours, sla_hours: SLA_HOURS[String(t.priority)], sla_breached: open && ageHours > SLA_HOURS[String(t.priority)] };
  }

  /** Whether the product on an order is still under warranty. */
  function warrantyStatus(orderId: number | null, productId: number | null) {
    if (!orderId || !productId) return null;
    const row = db.get<{ created_at: string; warranty_months: number }>(
      `SELECT o.created_at, p.warranty_months FROM orders o JOIN order_items oi ON oi.order_id = o.id
       JOIN products p ON p.id = oi.product_id WHERE o.id = ? AND p.id = ?`,
      orderId,
      productId,
    );
    if (!row) return { in_warranty: null, note: "Product is not on that order" };
    const purchased = new Date(row.created_at.replace(" ", "T") + "Z");
    const expires = new Date(purchased);
    expires.setUTCMonth(expires.getUTCMonth() + Number(row.warranty_months));
    return { in_warranty: expires.getTime() >= Date.now(), purchased_at: row.created_at, warranty_expires: expires.toISOString().slice(0, 10) };
  }

  function getTicket(id: number) {
    const t = db.get(
      `SELECT t.*, c.name AS contact_name, c.email AS contact_email, o.number AS order_number, p.sku AS product_sku
       FROM tickets t LEFT JOIN contacts c ON c.id = t.contact_id LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN products p ON p.id = t.product_id WHERE t.id = ?`,
      id,
    );
    assert(t, `Ticket #${id} not found`);
    return decorate(t);
  }

  return [
    defineTool({
      name: "ticket_create",
      title: "Create ticket",
      description:
        "Open a support, RMA (return), warranty, question or complaint ticket. Link the customer, order and product when known — " +
        "for RMA/warranty tickets the response says whether the unit is still under warranty.",
      input: {
        title: z.string().min(1),
        description: z.string().optional(),
        type: z.enum(TICKET_TYPES).default("support"),
        priority: z.enum(PRIORITIES).default("medium"),
        email: z.string().optional(),
        contact_id: z.number().int().optional(),
        order_number: z.string().optional(),
        sku: z.string().optional(),
        assignee: z.string().optional(),
      },
      handler: async (a) => {
        const contact = a.contact_id || a.email ? findContact(db, a) : undefined;
        const order = a.order_number ? findOrder(db, { number: a.order_number }) : undefined;
        const product = a.sku ? findProduct(db, { sku: a.sku }) : undefined;
        const contactId = (contact?.id ?? order?.contact_id ?? null) as number | null;
        const id = db.run(
          "INSERT INTO tickets (title, description, type, priority, contact_id, order_id, product_id, assignee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          a.title,
          a.description ?? null,
          a.type,
          a.priority,
          contactId,
          (order?.id as number | undefined) ?? null,
          (product?.id as number | undefined) ?? null,
          a.assignee ?? null,
        ).id;
        if (contactId) logActivity(db, "contact", contactId, "system", `Opened ticket SUP-${id}: ${a.title}`);
        const ticket = getTicket(id);
        const contactRow = contactId ? db.get("SELECT id, name, email FROM contacts WHERE id = ?", contactId) : null;
        await events.emit("ticket.created", { type: "ticket", id }, `SUP-${id} (${a.priority}) ${a.title}`, { ticket, contact: contactRow ?? null });
        return {
          ticket,
          warranty: a.type === "rma" || a.type === "warranty" ? warrantyStatus(ticket.order_id as number | null, ticket.product_id as number | null) : undefined,
        };
      },
    }),

    defineTool({
      name: "ticket_update",
      title: "Update ticket",
      description: "Change a ticket's status, priority or assignee, add a comment, or resolve it with a resolution note.",
      input: {
        ticket_id: z.number().int(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        assignee: z.string().optional(),
        comment: z.string().optional(),
        resolution: z.string().optional().describe("Required when resolving"),
      },
      handler: async (a) => {
        const before = findById(db, "tickets", a.ticket_id, "Ticket");
        const changing = a.status !== undefined && a.status !== before.status;
        const resolving = changing && (a.status === "resolved" || a.status === "closed");
        if (a.status === "resolved") assert(a.resolution || before.resolution, "resolution is required when resolving a ticket");
        updateRow(db, "tickets", a.ticket_id, {
          status: a.status,
          priority: a.priority,
          assignee: a.assignee,
          resolution: a.resolution,
          resolved_at: changing ? (resolving ? before.resolved_at ?? nowSql() : null) : undefined,
        });
        if (a.comment) logActivity(db, "ticket", a.ticket_id, "comment", a.comment);
        const ticket = getTicket(a.ticket_id);
        if (changing) {
          logActivity(db, "ticket", a.ticket_id, "system", `Status ${before.status} → ${a.status}`);
          await events.emit("ticket.status_changed", { type: "ticket", id: a.ticket_id }, `SUP-${a.ticket_id}: ${before.status} → ${a.status}`, {
            ticket,
            from: before.status,
            to: a.status,
          });
        }
        return { ticket };
      },
    }),

    defineTool({
      name: "ticket_get",
      title: "Get ticket",
      description: "One ticket with customer, order, product, warranty status and comment history.",
      readOnly: true,
      input: { ticket_id: z.number().int() },
      handler: (a) => {
        const ticket = getTicket(a.ticket_id);
        return {
          ticket,
          warranty: warrantyStatus(ticket.order_id as number | null, ticket.product_id as number | null),
          history: timeline(db, "ticket", a.ticket_id, 50),
        };
      },
    }),

    defineTool({
      name: "ticket_list",
      title: "Ticket triage queue",
      description:
        "Tickets sorted for triage (priority, then oldest first) with SLA breach flags. Defaults to unresolved tickets. " +
        "Includes per-product counts to spot recurring hardware faults.",
      readOnly: true,
      input: {
        status: z.enum([...STATUSES, "unresolved", "all"]).default("unresolved"),
        type: z.enum(TICKET_TYPES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        assignee: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      handler: (a) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (a.status === "unresolved") where.push("t.status NOT IN ('resolved','closed')");
        else if (a.status !== "all") {
          where.push("t.status = ?");
          params.push(a.status);
        }
        if (a.type) {
          where.push("t.type = ?");
          params.push(a.type);
        }
        if (a.priority) {
          where.push("t.priority = ?");
          params.push(a.priority);
        }
        if (a.assignee) {
          where.push("t.assignee = ? COLLATE NOCASE");
          params.push(a.assignee);
        }
        const clause = where.length ? "WHERE " + where.join(" AND ") : "";
        const rows = db.all(
          `SELECT t.id, t.title, t.type, t.priority, t.status, t.assignee, t.created_at, c.name AS contact_name, p.sku AS product_sku
           FROM tickets t LEFT JOIN contacts c ON c.id = t.contact_id LEFT JOIN products p ON p.id = t.product_id
           ${clause} ORDER BY ${PRIORITY_RANK}, t.created_at LIMIT ?`,
          ...params,
          a.limit,
        );
        const byProduct = db.all(
          `SELECT p.sku, p.name, COUNT(*) AS tickets FROM tickets t JOIN products p ON p.id = t.product_id
           ${clause} GROUP BY p.id HAVING COUNT(*) > 1 ORDER BY tickets DESC`,
          ...params,
        );
        const tickets = rows.map(decorate);
        return { count: tickets.length, sla_breached: tickets.filter((t) => t.sla_breached).length, tickets, recurring_by_product: byProduct };
      },
    }),
  ];
}
