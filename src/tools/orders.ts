import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import type { Row } from "../db.js";
import {
  assert,
  daysBetween,
  findContact,
  findOrder,
  findProduct,
  logActivity,
  nowSql,
  present,
  presentAll,
  timeline,
  toCents,
  updateRow,
} from "../util.js";
import { moveStock } from "./catalog.js";
import { STAGE_PROBABILITY } from "./crm.js";

/**
 * Sales orders and fulfillment — modeled on the Shopify MCP's order
 * management: take orders, keep stock in sync, ship and handle refunds.
 */

export const ORDER_STATUSES = ["pending", "paid", "fulfilled", "shipped", "delivered", "cancelled", "refunded"] as const;

const TRANSITIONS: Record<string, string[]> = {
  pending: ["paid", "cancelled"],
  paid: ["fulfilled", "shipped", "refunded", "cancelled"],
  fulfilled: ["shipped", "refunded"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function orderTools(ctx: Ctx) {
  const { db, events } = ctx;

  function getOrder(id: number): Row & { items: Row[] } {
    const o = db.get(
      `SELECT o.*, c.name AS customer_name, c.email AS customer_email FROM orders o
       LEFT JOIN contacts c ON c.id = o.contact_id WHERE o.id = ?`,
      id,
    );
    assert(o, `Order #${id} not found`);
    const items = db.all(
      "SELECT sku, name, qty, unit_price_cents, unit_cost_cents, qty * unit_price_cents AS line_total_cents FROM order_items WHERE order_id = ?",
      id,
    );
    const cost = items.reduce((s, i) => s + Number(i.unit_cost_cents) * Number(i.qty), 0);
    const net = Number(o.subtotal_cents) - Number(o.discount_cents);
    return {
      ...present(o)!,
      items: presentAll(items),
      gross_profit: (net - cost) / 100,
      allowed_next_status: TRANSITIONS[String(o.status)],
    };
  }

  return [
    defineTool({
      name: "order_create",
      title: "Create sales order",
      description:
        "Record a sale. Identify the customer by contact_id or email (a new customer is created if `customer_name` is given and the email is unknown). " +
        "Stock is reserved immediately; the order fails if stock is insufficient unless allow_backorder is set. " +
        "Linking a deal marks it won. Leads are promoted to customers.",
      input: {
        contact_id: z.number().int().optional(),
        email: z.string().optional(),
        customer_name: z.string().optional().describe("Creates the customer if the email is not known yet"),
        items: z
          .array(
            z.object({
              sku: z.string(),
              qty: z.number().int().positive(),
              unit_price: z.number().nonnegative().optional().describe("Override list price (e.g. negotiated bulk price)"),
            }),
          )
          .min(1),
        discount: z.number().nonnegative().optional().describe("Order-level discount amount"),
        discount_pct: z.number().min(0).max(100).optional().describe("Order-level discount percent (alternative to discount)"),
        shipping: z.number().nonnegative().default(0),
        tax_rate: z.number().min(0).max(1).optional().describe("e.g. 0.2 for 20%; defaults to the server's configured rate"),
        paid: z.boolean().default(false).describe("Mark as paid immediately"),
        channel: z.string().default("direct").describe("Where the sale came from: direct, website, marketplace, phone..."),
        shipping_address: z.string().optional(),
        deal_id: z.number().int().optional(),
        notes: z.string().optional(),
        allow_backorder: z.boolean().default(false),
      },
      handler: async (a) => {
        let contact: Row | undefined;
        if (a.contact_id || a.email) {
          contact =
            (a.contact_id && db.get("SELECT * FROM contacts WHERE id = ?", a.contact_id)) ||
            (a.email && db.get("SELECT * FROM contacts WHERE email = ? COLLATE NOCASE", a.email)) ||
            undefined;
          if (!contact) {
            assert(a.email && a.customer_name, `Customer not found. Pass customer_name with the email to create them.`);
            const id = db.run("INSERT INTO contacts (name, email, type) VALUES (?, ?, 'customer')", a.customer_name, a.email).id;
            contact = db.get("SELECT * FROM contacts WHERE id = ?", id);
            await events.emit("contact.created", { type: "contact", id }, `New customer: ${a.customer_name}`, { contact: present(contact, ["tags"]) });
          }
        }
        assert(!(a.discount && a.discount_pct), "Use either discount or discount_pct, not both");

        const lines = a.items.map((item) => {
          const p = findProduct(db, item);
          assert(p.status !== "archived", `${p.sku} is archived`);
          assert(
            a.allow_backorder || Number(p.stock_qty) >= item.qty,
            `Insufficient stock for ${p.sku}: ${p.stock_qty} available, ${item.qty} requested`,
          );
          return { product: p, qty: item.qty, price: item.unit_price !== undefined ? toCents(item.unit_price) : Number(p.price_cents) };
        });
        const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
        const discount = a.discount_pct ? Math.round((subtotal * a.discount_pct) / 100) : toCents(a.discount ?? 0);
        assert(discount <= subtotal, "Discount exceeds subtotal");
        const shipping = toCents(a.shipping);
        const taxRate = a.tax_rate ?? ctx.config.defaultTaxRate;
        const tax = Math.round((subtotal - discount + shipping) * taxRate);
        const total = subtotal - discount + shipping + tax;
        if (a.deal_id) assert(db.get("SELECT id FROM deals WHERE id = ?", a.deal_id), `Deal #${a.deal_id} not found`);

        const orderId = db.tx(() => {
          const next = db.get<{ n: number }>("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM orders")!.n;
          const id = db.run(
            `INSERT INTO orders (number, contact_id, deal_id, status, subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
               channel, shipping_address, notes, paid_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            `SO-${1000 + next}`,
            (contact?.id as number | undefined) ?? null,
            a.deal_id ?? null,
            a.paid ? "paid" : "pending",
            subtotal,
            discount,
            shipping,
            tax,
            total,
            a.channel,
            a.shipping_address ?? null,
            a.notes ?? null,
            a.paid ? nowSql() : null,
          ).id;
          for (const l of lines) {
            db.run(
              "INSERT INTO order_items (order_id, product_id, sku, name, qty, unit_price_cents, unit_cost_cents) VALUES (?, ?, ?, ?, ?, ?, ?)",
              id,
              Number(l.product.id),
              String(l.product.sku),
              String(l.product.name),
              l.qty,
              l.price,
              Number(l.product.cost_cents),
            );
          }
          return id;
        });
        const number = `SO-${1000 + orderId}`;
        for (const l of lines) await moveStock(ctx, Number(l.product.id), -l.qty, "sale", number);

        if (contact) {
          if (contact.type === "lead") db.run("UPDATE contacts SET type = 'customer', updated_at = datetime('now') WHERE id = ?", Number(contact.id));
          logActivity(db, "contact", Number(contact.id), "system", `Placed order ${number}`);
        }
        if (a.deal_id) {
          const deal = db.get("SELECT * FROM deals WHERE id = ?", a.deal_id)!;
          if (deal.stage !== "won") {
            db.run("UPDATE deals SET stage = 'won', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", a.deal_id);
            logActivity(db, "deal", a.deal_id, "system", `Won via order ${number}`);
            await events.emit("deal.stage_changed", { type: "deal", id: a.deal_id }, `${deal.title}: ${deal.stage} → won`, {
              deal: { ...present(deal), stage: "won", probability: STAGE_PROBABILITY.won },
              from: deal.stage,
              to: "won",
            });
          }
        }
        const order = getOrder(orderId);
        await events.emit("order.created", { type: "order", id: orderId }, `${number} — ${order.total} (${order.customer_name ?? "walk-in"})`, {
          order,
          contact: present(contact, ["tags"]) ?? null,
          items: order.items,
        });
        return { order };
      },
    }),

    defineTool({
      name: "order_update",
      title: "Update order status",
      description:
        "Advance an order: pending → paid → fulfilled → shipped → delivered, or cancel/refund. " +
        "Cancelling restocks items; refunding restocks unless restock=false (e.g. the unit was faulty). Add carrier and tracking when shipping.",
      input: {
        order_id: z.number().int().optional(),
        number: z.string().optional().describe("Order number, e.g. SO-1001"),
        status: z.enum(ORDER_STATUSES).optional(),
        carrier: z.string().optional(),
        tracking_number: z.string().optional(),
        shipping_address: z.string().optional(),
        notes: z.string().optional(),
        restock: z.boolean().default(true),
      },
      handler: async (a) => {
        const o = findOrder(db, a);
        const id = Number(o.id);
        const from = String(o.status);
        const changing = a.status !== undefined && a.status !== from;
        if (changing) {
          assert(
            TRANSITIONS[from].includes(a.status!),
            `Cannot move ${o.number} from ${from} to ${a.status}. Allowed: ${TRANSITIONS[from].join(", ") || "none"}`,
          );
        }
        updateRow(db, "orders", id, {
          status: a.status,
          carrier: a.carrier,
          tracking_number: a.tracking_number,
          shipping_address: a.shipping_address,
          notes: a.notes,
          paid_at: changing && a.status === "paid" ? nowSql() : undefined,
          shipped_at: changing && a.status === "shipped" ? nowSql() : undefined,
        });
        if (changing && (a.status === "cancelled" || (a.status === "refunded" && a.restock))) {
          const items = db.all("SELECT product_id, qty FROM order_items WHERE order_id = ? AND product_id IS NOT NULL", id);
          for (const i of items) await moveStock(ctx, Number(i.product_id), Number(i.qty), a.status === "cancelled" ? "cancellation" : "return", String(o.number));
        }
        const order = getOrder(id);
        if (changing) {
          logActivity(db, "order", id, "system", `Status ${from} → ${a.status}${a.tracking_number ? ` (tracking ${a.tracking_number})` : ""}`);
          const contact = o.contact_id ? db.get("SELECT * FROM contacts WHERE id = ?", Number(o.contact_id)) : undefined;
          await events.emit("order.status_changed", { type: "order", id }, `${o.number}: ${from} → ${a.status}`, {
            order,
            from,
            to: a.status,
            contact: present(contact, ["tags"]) ?? null,
          });
        }
        return { order };
      },
    }),

    defineTool({
      name: "order_get",
      title: "Get order",
      description: "One order with line items, profit, customer, related tickets and timeline.",
      readOnly: true,
      input: { order_id: z.number().int().optional(), number: z.string().optional() },
      handler: (a) => {
        const o = findOrder(db, a);
        const id = Number(o.id);
        return {
          order: getOrder(id),
          tickets: db.all("SELECT id, title, type, status FROM tickets WHERE order_id = ?", id),
          timeline: timeline(db, "order", id),
        };
      },
    }),

    defineTool({
      name: "order_list",
      title: "List orders",
      description:
        "Orders, newest first. Filter by status, customer, channel or date. `needs_attention` returns unpaid orders older than 3 days and paid orders not shipped within 2 days.",
      readOnly: true,
      input: {
        status: z.enum(ORDER_STATUSES).optional(),
        contact_id: z.number().int().optional(),
        email: z.string().optional(),
        channel: z.string().optional(),
        since: z.string().optional().describe("YYYY-MM-DD"),
        needs_attention: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      handler: (a) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (a.status) {
          where.push("o.status = ?");
          params.push(a.status);
        }
        if (a.contact_id || a.email) {
          where.push("o.contact_id = ?");
          params.push(Number(findContact(db, a).id));
        }
        if (a.channel) {
          where.push("o.channel = ? COLLATE NOCASE");
          params.push(a.channel);
        }
        if (a.since) {
          where.push("o.created_at >= ?");
          params.push(a.since);
        }
        if (a.needs_attention) {
          where.push(
            "((o.status = 'pending' AND o.created_at <= datetime('now','-3 days')) OR (o.status IN ('paid','fulfilled') AND COALESCE(o.paid_at, o.created_at) <= datetime('now','-2 days')))",
          );
        }
        const rows = db.all(
          `SELECT o.id, o.number, o.status, o.total_cents, o.channel, o.created_at, o.paid_at, o.tracking_number, c.name AS customer
           FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY o.id DESC LIMIT ?`,
          ...params,
          a.limit,
        );
        return {
          count: rows.length,
          orders: presentAll(rows).map((r) => ({ ...r, age_days: daysBetween(String(r.created_at)) })),
        };
      },
    }),
  ];
}
