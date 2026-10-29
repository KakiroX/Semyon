import type { Db, Row } from "./db.js";

/** An error caused by bad input; reported back to the model as a tool error. */
export class UserError extends Error {}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new UserError(message);
}

/** Money is stored as integer cents and exposed as decimal currency units. */
export const toCents = (amount: number): number => Math.round(amount * 100);
export const fromCents = (cents: unknown): number => Math.round(Number(cents ?? 0)) / 100;

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** SQLite-compatible UTC timestamp ("YYYY-MM-DD HH:MM:SS"). */
export function nowSql(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  return nowSql(new Date(Date.now() - n * 86_400_000));
}

export function daysBetween(fromSql: string, to = new Date()): number {
  const from = new Date(fromSql.replace(" ", "T") + (fromSql.length > 10 ? "Z" : "T00:00:00Z"));
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** Converts money columns (`*_cents`) to currency units and parses JSON columns. */
export function present(row: Row | undefined, jsonCols: string[] = []): Row | undefined {
  if (!row) return row;
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith("_cents")) out[k.slice(0, -6)] = fromCents(v);
    else if (jsonCols.includes(k)) out[k] = parseJson(v, null);
    else out[k] = v;
  }
  return out;
}

export function presentAll(rows: Row[], jsonCols: string[] = []): Row[] {
  return rows.map((r) => present(r, jsonCols)!);
}

/** Builds a partial UPDATE from the defined keys of `fields`. */
export function updateRow(db: Db, table: string, id: number, fields: Record<string, unknown>, touch = true): number {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return 0;
  const sets = entries.map(([k]) => `${k} = ?`);
  if (touch) sets.push("updated_at = datetime('now')");
  const values = entries.map(([, v]) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)) as (string | number | null)[];
  return db.run(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, ...values, id).changes;
}

// ---- Lookups shared across modules -------------------------------------------------

export function findProduct(db: Db, ref: { product_id?: number; sku?: string }): Row {
  const row = ref.product_id
    ? db.get("SELECT * FROM products WHERE id = ?", ref.product_id)
    : ref.sku
      ? db.get("SELECT * FROM products WHERE sku = ? COLLATE NOCASE", ref.sku)
      : undefined;
  assert(row, `Product not found (${ref.sku ?? ref.product_id ?? "no sku/product_id given"})`);
  return row;
}

export function findContact(db: Db, ref: { contact_id?: number; email?: string }): Row {
  const row = ref.contact_id
    ? db.get("SELECT * FROM contacts WHERE id = ?", ref.contact_id)
    : ref.email
      ? db.get("SELECT * FROM contacts WHERE email = ? COLLATE NOCASE", ref.email)
      : undefined;
  assert(row, `Contact not found (${ref.email ?? ref.contact_id ?? "no email/contact_id given"})`);
  return row;
}

export function findById(db: Db, table: string, id: number, label = table): Row {
  const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  assert(row, `${label} #${id} not found`);
  return row;
}

export function findOrder(db: Db, ref: { order_id?: number; number?: string }): Row {
  const row = ref.order_id
    ? db.get("SELECT * FROM orders WHERE id = ?", ref.order_id)
    : ref.number
      ? db.get("SELECT * FROM orders WHERE number = ? COLLATE NOCASE", ref.number)
      : undefined;
  assert(row, `Order not found (${ref.number ?? ref.order_id ?? "no number/order_id given"})`);
  return row;
}

export function logActivity(db: Db, entityType: string, entityId: number, kind: string, body: string): number {
  return db.run("INSERT INTO activities (entity_type, entity_id, kind, body) VALUES (?, ?, ?, ?)", entityType, entityId, kind, body).id;
}

export function timeline(db: Db, entityType: string, entityId: number, limit = 20): Row[] {
  return db.all(
    "SELECT id, kind, body, created_at FROM activities WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    entityType,
    entityId,
    limit,
  );
}
