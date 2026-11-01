import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import type { Row } from "../db.js";
import {
  assert,
  findById,
  findProduct,
  fromCents,
  parseJson,
  present,
  presentAll,
  toCents,
  updateRow,
} from "../util.js";

/**
 * Catalog, inventory and purchasing — modeled on the Shopify MCP: Claude can
 * merchandise products, keep stock right, and restock from suppliers.
 */

const PRODUCT_STATUS = ["active", "draft", "archived"] as const;

export function presentProduct(row: Row | undefined): Row | undefined {
  const p = present(row, ["specs"]);
  if (p) {
    p.margin_pct = Number(p.price) > 0 ? Math.round(((Number(p.price) - Number(p.cost)) / Number(p.price)) * 1000) / 10 : null;
    p.low_stock = Number(p.stock_qty) <= Number(p.reorder_point);
  }
  return p;
}

/**
 * Moves stock and records why. Emits inventory.low_stock when the change takes
 * the product from above its reorder point to at or below it.
 */
export async function moveStock(ctx: Ctx, productId: number, delta: number, reason: string, ref?: string, note?: string) {
  const { db, events } = ctx;
  const before = findById(db, "products", productId, "Product");
  db.run("UPDATE products SET stock_qty = stock_qty + ?, updated_at = datetime('now') WHERE id = ?", delta, productId);
  db.run(
    "INSERT INTO stock_movements (product_id, delta, reason, ref, note) VALUES (?, ?, ?, ?, ?)",
    productId,
    delta,
    reason,
    ref ?? null,
    note ?? null,
  );
  const after = findById(db, "products", productId, "Product");
  const product = presentProduct(after)!;
  await events.emit("inventory.adjusted", { type: "product", id: productId }, `${after.sku}: ${delta > 0 ? "+" : ""}${delta} (${reason})`, {
    product,
    delta,
    reason,
  });
  const point = Number(after.reorder_point);
  if (Number(before.stock_qty) > point && Number(after.stock_qty) <= point) {
    await events.emit("inventory.low_stock", { type: "product", id: productId }, `${after.sku} is low: ${after.stock_qty} left`, {
      product,
    });
  }
  return product;
}

export function catalogTools(ctx: Ctx) {
  const { db, events } = ctx;

  return [
    defineTool({
      name: "product_upsert",
      title: "Create or update product",
      description:
        "Create a product, or update it if the SKU already exists. Prices are in currency units (e.g. 19.99). " +
        "Use `specs` for technical attributes (voltage, interface, dimensions...) that power product copy and spec sheets. " +
        "Stock is changed with inventory_adjust, not here (initial_stock only applies on creation).",
      input: {
        sku: z.string().min(1).describe("Unique stock keeping unit, e.g. 'RPI5-8GB'"),
        name: z.string().optional(),
        description: z.string().optional(),
        category: z.string().optional().describe("e.g. 'Single-board computers', 'Sensors', 'Cables'"),
        brand: z.string().optional(),
        price: z.number().nonnegative().optional(),
        cost: z.number().nonnegative().optional().describe("Unit cost from the supplier"),
        initial_stock: z.number().int().nonnegative().optional(),
        reorder_point: z.number().int().nonnegative().optional().describe("Alert when stock falls to this level"),
        reorder_qty: z.number().int().nonnegative().optional().describe("Default quantity to reorder"),
        supplier: z.string().optional().describe("Supplier name (must exist, see supplier_upsert)"),
        specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        warranty_months: z.number().int().nonnegative().optional(),
        status: z.enum(PRODUCT_STATUS).optional(),
      },
      handler: async (a) => {
        let supplierId: number | undefined;
        if (a.supplier) {
          const s = db.get<{ id: number }>("SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE", a.supplier);
          assert(s, `Supplier '${a.supplier}' not found. Create it with supplier_upsert first.`);
          supplierId = s.id;
        }
        const existing = db.get("SELECT * FROM products WHERE sku = ? COLLATE NOCASE", a.sku);
        if (existing) {
          const id = Number(existing.id);
          const specs = a.specs ? { ...parseJson<Record<string, unknown>>(existing.specs, {}), ...a.specs } : undefined;
          updateRow(db, "products", id, {
            name: a.name,
            description: a.description,
            category: a.category,
            brand: a.brand,
            price_cents: a.price !== undefined ? toCents(a.price) : undefined,
            cost_cents: a.cost !== undefined ? toCents(a.cost) : undefined,
            reorder_point: a.reorder_point,
            reorder_qty: a.reorder_qty,
            supplier_id: supplierId,
            specs,
            warranty_months: a.warranty_months,
            status: a.status,
          });
          const product = presentProduct(findById(db, "products", id))!;
          const changes = Object.keys(a).filter((k) => k !== "sku" && k !== "initial_stock" && a[k as keyof typeof a] !== undefined);
          await events.emit("product.updated", { type: "product", id }, `Updated ${a.sku}: ${changes.join(", ")}`, { product, changes });
          return { action: "updated", product };
        }
        assert(a.name, "name is required when creating a product");
        const id = db.run(
          `INSERT INTO products (sku, name, description, category, brand, price_cents, cost_cents, stock_qty,
             reorder_point, reorder_qty, supplier_id, specs, warranty_months, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          a.sku,
          a.name,
          a.description ?? null,
          a.category ?? null,
          a.brand ?? null,
          toCents(a.price ?? 0),
          toCents(a.cost ?? 0),
          a.initial_stock ?? 0,
          a.reorder_point ?? 0,
          a.reorder_qty ?? 0,
          supplierId ?? null,
          JSON.stringify(a.specs ?? {}),
          a.warranty_months ?? 12,
          a.status ?? "active",
        ).id;
        if (a.initial_stock) {
          db.run("INSERT INTO stock_movements (product_id, delta, reason) VALUES (?, ?, 'initial')", id, a.initial_stock);
        }
        const product = presentProduct(findById(db, "products", id))!;
        await events.emit("product.created", { type: "product", id }, `New product ${a.sku} — ${a.name}`, { product });
        return { action: "created", product };
      },
    }),

    defineTool({
      name: "product_get",
      title: "Get product details",
      description: "Full product record by SKU or id: pricing, margin, stock, supplier, recent stock movements, 90-day sales and open tickets.",
      readOnly: true,
      input: {
        sku: z.string().optional(),
        product_id: z.number().int().optional(),
      },
      handler: (a) => {
        const row = findProduct(db, a);
        const id = Number(row.id);
        const sales = db.get(
          `SELECT COALESCE(SUM(oi.qty), 0) AS units, COALESCE(SUM(oi.qty * oi.unit_price_cents), 0) AS revenue_cents
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE oi.product_id = ? AND o.status NOT IN ('cancelled', 'refunded', 'pending')
             AND o.created_at >= datetime('now', '-90 days')`,
          id,
        );
        return {
          product: presentProduct(row),
          supplier: row.supplier_id ? present(findById(db, "suppliers", Number(row.supplier_id))) : null,
          sales_last_90_days: present(sales),
          recent_stock_movements: db.all(
            "SELECT delta, reason, ref, note, created_at FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT 10",
            id,
          ),
          open_tickets: db.all(
            "SELECT id, title, type, priority, status FROM tickets WHERE product_id = ? AND status NOT IN ('resolved', 'closed')",
            id,
          ),
        };
      },
    }),

    defineTool({
      name: "product_search",
      title: "Search products",
      description: "Search the catalog by text (SKU, name, description, brand), category or status. Set low_stock_only to see what needs restocking.",
      readOnly: true,
      input: {
        query: z.string().optional(),
        category: z.string().optional(),
        status: z.enum(PRODUCT_STATUS).optional(),
        low_stock_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      handler: (a) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (a.query) {
          where.push("(sku LIKE ? OR name LIKE ? OR description LIKE ? OR brand LIKE ?)");
          const q = `%${a.query}%`;
          params.push(q, q, q, q);
        }
        if (a.category) {
          where.push("category = ? COLLATE NOCASE");
          params.push(a.category);
        }
        if (a.status) {
          where.push("status = ?");
          params.push(a.status);
        }
        if (a.low_stock_only) where.push("stock_qty <= reorder_point");
        const rows = db.all(
          `SELECT * FROM products ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY name LIMIT ?`,
          ...params,
          a.limit,
        );
        return { count: rows.length, products: rows.map((r) => presentProduct(r)) };
      },
    }),

    defineTool({
      name: "inventory_adjust",
      title: "Adjust stock",
      description:
        "Add or remove stock for a SKU with a reason (stock count correction, damaged unit, return to stock...). " +
        "Sales and purchase-order receipts adjust stock automatically, so don't double count them.",
      input: {
        sku: z.string(),
        delta: z.number().int().refine((n) => n !== 0, "delta must not be 0").describe("Positive to add, negative to remove"),
        reason: z.enum(["count_correction", "damaged", "return", "sample", "other"]),
        note: z.string().optional(),
      },
      handler: async (a) => {
        const product = findProduct(db, a);
        assert(Number(product.stock_qty) + a.delta >= 0, `Cannot remove ${-a.delta}; only ${product.stock_qty} in stock`);
        return { product: await moveStock(ctx, Number(product.id), a.delta, a.reason, undefined, a.note) };
      },
    }),

    defineTool({
      name: "inventory_report",
      title: "Inventory health report",
      description:
        "Stock valuation, products at/below reorder point with suggested reorder quantities grouped by supplier, " +
        "days of cover based on the last 30 days of sales, and dead stock (no sales in 90 days).",
      readOnly: true,
      input: {},
      handler: () => {
        const valuation = db.get(
          `SELECT COUNT(*) AS active_skus, COALESCE(SUM(stock_qty), 0) AS units,
                  COALESCE(SUM(stock_qty * cost_cents), 0) AS value_at_cost_cents,
                  COALESCE(SUM(stock_qty * price_cents), 0) AS value_at_retail_cents
           FROM products WHERE status = 'active'`,
        );
        const rows = db.all(
          `SELECT p.*, s.name AS supplier_name, s.lead_time_days,
             COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                       WHERE oi.product_id = p.id AND o.status NOT IN ('cancelled','refunded')
                         AND o.created_at >= datetime('now','-30 days')), 0) AS sold_30d,
             COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                       WHERE oi.product_id = p.id AND o.status NOT IN ('cancelled','refunded')
                         AND o.created_at >= datetime('now','-90 days')), 0) AS sold_90d,
             COALESCE((SELECT SUM(poi.qty) FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
                       WHERE poi.product_id = p.id AND po.status = 'ordered'), 0) AS on_order
           FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE p.status = 'active'`,
        );
        const reorder: Record<string, Row[]> = {};
        const deadStock: Row[] = [];
        for (const r of rows) {
          const daily = Number(r.sold_30d) / 30;
          const cover = daily > 0 ? Math.round(Number(r.stock_qty) / daily) : null;
          const leadTime = Number(r.lead_time_days ?? 7);
          const needsReorder =
            Number(r.stock_qty) + Number(r.on_order) <= Number(r.reorder_point) || (cover !== null && cover <= leadTime);
          if (needsReorder) {
            const demandDuringLead = Math.ceil(daily * leadTime * 2);
            const suggested = Math.max(Number(r.reorder_qty), demandDuringLead, Number(r.reorder_point) - Number(r.stock_qty) + 1);
            const key = String(r.supplier_name ?? "(no supplier)");
            (reorder[key] ??= []).push({
              sku: r.sku,
              name: r.name,
              stock_qty: r.stock_qty,
              on_order: r.on_order,
              reorder_point: r.reorder_point,
              days_of_cover: cover,
              suggested_qty: suggested,
              est_cost: fromCents(suggested * Number(r.cost_cents)),
            });
          }
          if (Number(r.sold_90d) === 0 && Number(r.stock_qty) > 0) {
            deadStock.push({ sku: r.sku, name: r.name, stock_qty: r.stock_qty, tied_up_cost: fromCents(Number(r.stock_qty) * Number(r.cost_cents)) });
          }
        }
        return { valuation: present(valuation), reorder_suggestions_by_supplier: reorder, dead_stock_90d: deadStock };
      },
    }),

    defineTool({
      name: "supplier_upsert",
      title: "Create or update supplier",
      description: "Create a supplier, or update it if one with this name exists.",
      input: {
        name: z.string().min(1),
        email: z.string().optional(),
        phone: z.string().optional(),
        lead_time_days: z.number().int().nonnegative().optional(),
        notes: z.string().optional(),
      },
      handler: (a) => {
        const existing = db.get<{ id: number }>("SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE", a.name);
        if (existing) {
          updateRow(db, "suppliers", existing.id, { email: a.email, phone: a.phone, lead_time_days: a.lead_time_days, notes: a.notes }, false);
          return { action: "updated", supplier: findById(db, "suppliers", existing.id) };
        }
        const id = db.run(
          "INSERT INTO suppliers (name, email, phone, lead_time_days, notes) VALUES (?, ?, ?, ?, ?)",
          a.name,
          a.email ?? null,
          a.phone ?? null,
          a.lead_time_days ?? 7,
          a.notes ?? null,
        ).id;
        return { action: "created", supplier: findById(db, "suppliers", id) };
      },
    }),

    defineTool({
      name: "supplier_list",
      title: "List suppliers",
      description: "All suppliers with product counts and open purchase orders.",
      readOnly: true,
      input: {},
      handler: () => ({
        suppliers: db.all(
          `SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS product_count,
                  (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status = 'ordered') AS open_purchase_orders
           FROM suppliers s ORDER BY s.name`,
        ),
      }),
    }),

    defineTool({
      name: "purchase_order_create",
      title: "Create purchase order",
      description: "Place a purchase order with a supplier. Unit cost defaults to the product's current cost.",
      input: {
        supplier: z.string(),
        items: z
          .array(z.object({ sku: z.string(), qty: z.number().int().positive(), unit_cost: z.number().nonnegative().optional() }))
          .min(1),
        expected_date: z.string().optional().describe("YYYY-MM-DD; defaults to today + supplier lead time"),
        notes: z.string().optional(),
      },
      handler: async (a) => {
        const supplier = db.get("SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE", a.supplier);
        assert(supplier, `Supplier '${a.supplier}' not found`);
        const expected =
          a.expected_date ?? new Date(Date.now() + Number(supplier.lead_time_days) * 86_400_000).toISOString().slice(0, 10);
        const poId = db.tx(() => {
          const id = db.run(
            "INSERT INTO purchase_orders (supplier_id, expected_date, notes) VALUES (?, ?, ?)",
            Number(supplier.id),
            expected,
            a.notes ?? null,
          ).id;
          for (const item of a.items) {
            const p = findProduct(db, item);
            db.run(
              "INSERT INTO purchase_order_items (po_id, product_id, qty, unit_cost_cents) VALUES (?, ?, ?, ?)",
              id,
              Number(p.id),
              item.qty,
              item.unit_cost !== undefined ? toCents(item.unit_cost) : Number(p.cost_cents),
            );
          }
          return id;
        });
        const po = getPurchaseOrder(poId);
        await events.emit("purchase_order.created", { type: "purchase_order", id: poId }, `PO-${poId} to ${supplier.name}`, {
          purchase_order: po,
          supplier: present(supplier),
        });
        return po;
      },
    }),

    defineTool({
      name: "purchase_order_receive",
      title: "Receive purchase order",
      description: "Mark a purchase order as received: adds the units to stock and updates product cost to the PO unit cost.",
      input: { po_id: z.number().int() },
      handler: async (a) => {
        const po = findById(db, "purchase_orders", a.po_id, "Purchase order");
        assert(po.status === "ordered", `PO-${a.po_id} is already ${po.status}`);
        const items = db.all("SELECT * FROM purchase_order_items WHERE po_id = ?", a.po_id);
        for (const item of items) {
          await moveStock(ctx, Number(item.product_id), Number(item.qty), "purchase", `PO-${a.po_id}`);
          db.run("UPDATE products SET cost_cents = ? WHERE id = ?", Number(item.unit_cost_cents), Number(item.product_id));
        }
        db.run("UPDATE purchase_orders SET status = 'received', received_at = datetime('now') WHERE id = ?", a.po_id);
        const result = getPurchaseOrder(a.po_id);
        const supplier = findById(db, "suppliers", Number(po.supplier_id));
        await events.emit("purchase_order.received", { type: "purchase_order", id: a.po_id }, `PO-${a.po_id} received`, {
          purchase_order: result,
          supplier: present(supplier),
        });
        return result;
      },
    }),

    defineTool({
      name: "purchase_order_cancel",
      title: "Cancel purchase order",
      description: "Cancel a purchase order that has not been received.",
      destructive: true,
      input: { po_id: z.number().int() },
      handler: (a) => {
        const po = findById(db, "purchase_orders", a.po_id, "Purchase order");
        assert(po.status === "ordered", `PO-${a.po_id} is already ${po.status}`);
        db.run("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", a.po_id);
        return getPurchaseOrder(a.po_id);
      },
    }),

    defineTool({
      name: "purchase_order_list",
      title: "List purchase orders",
      description: "Purchase orders, newest first, optionally filtered by status. Flags overdue deliveries.",
      readOnly: true,
      input: { status: z.enum(["ordered", "received", "cancelled"]).optional(), limit: z.number().int().min(1).max(100).default(25) },
      handler: (a) => {
        const ids = db.all<{ id: number }>(
          `SELECT id FROM purchase_orders ${a.status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT ?`,
          ...(a.status ? [a.status, a.limit] : [a.limit]),
        );
        return { purchase_orders: ids.map((r) => getPurchaseOrder(r.id)) };
      },
    }),
  ];

  function getPurchaseOrder(id: number) {
    const po = db.get(
      "SELECT po.*, s.name AS supplier FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?",
      id,
    )!;
    const items = db.all(
      `SELECT p.sku, p.name, poi.qty, poi.unit_cost_cents, poi.qty * poi.unit_cost_cents AS line_total_cents
       FROM purchase_order_items poi JOIN products p ON p.id = poi.product_id WHERE poi.po_id = ?`,
      id,
    );
    const total = items.reduce((s, i) => s + Number(i.line_total_cents), 0);
    return {
      ...po,
      reference: `PO-${id}`,
      overdue: po.status === "ordered" && !!po.expected_date && String(po.expected_date) < new Date().toISOString().slice(0, 10),
      items: presentAll(items),
      total: fromCents(total),
    };
  }
}
