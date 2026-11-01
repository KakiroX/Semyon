/**
 * Loads a demo hardware shop so you can try the server immediately:
 *   SEMYON_DB=./demo.db npm run seed
 * Refuses to run against a database that already has products.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { allTools, createContext } from "./server.js";

const dbPath = process.env.SEMYON_DB ?? join(homedir(), ".semyon", "semyon.db");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const ctx = createContext({ dbPath });
const { db } = ctx;

if (Number(db.get("SELECT COUNT(*) AS n FROM products")!.n) > 0) {
  console.error(`${dbPath} already has data; not seeding.`);
  process.exit(1);
}

const tools = new Map(allTools(ctx).map((t) => [t.name, t]));
/** Calls a tool handler directly, applying its schema defaults like the MCP layer does. */
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const tool = tools.get(name)!;
  return tool.handler(z.object(tool.input).parse(args) as never);
};
/** Moves a freshly created record back in time so reports have history. */
const backdate = (table: string, id: number, days: number) =>
  db.run(`UPDATE ${table} SET created_at = datetime('now', ?) WHERE id = ?`, `-${days} days`, id);

await call("supplier_upsert", { name: "Shenzhen Parts Co", email: "sales@szparts.example", lead_time_days: 14 });
await call("supplier_upsert", { name: "EuroComponents GmbH", email: "orders@eurocomp.example", lead_time_days: 5 });

const products = [
  { sku: "RPI5-8GB", name: "Raspberry Pi 5 (8GB)", category: "Single-board computers", brand: "Raspberry Pi", price: 89, cost: 72, initial_stock: 6, reorder_point: 5, reorder_qty: 20, supplier: "EuroComponents GmbH", specs: { cpu: "Cortex-A76 2.4GHz", ram_gb: 8, usb3_ports: 2 } },
  { sku: "ESP32-DEV", name: "ESP32 DevKitC", category: "Microcontrollers", brand: "Espressif", price: 12.5, cost: 4, initial_stock: 80, reorder_point: 20, reorder_qty: 100, supplier: "Shenzhen Parts Co", specs: { wifi: "802.11 b/g/n", bluetooth: "4.2", flash_mb: 4 } },
  { sku: "ARD-UNO-R4", name: "Arduino Uno R4 WiFi", category: "Microcontrollers", brand: "Arduino", price: 27.5, cost: 17, initial_stock: 15, reorder_point: 5, reorder_qty: 20, supplier: "EuroComponents GmbH", specs: { mcu: "Renesas RA4M1", wifi: true } },
  { sku: "BME280", name: "BME280 Temp/Humidity/Pressure Sensor", category: "Sensors", price: 9, cost: 2.2, initial_stock: 40, reorder_point: 10, reorder_qty: 50, supplier: "Shenzhen Parts Co", specs: { interface: "I2C/SPI", voltage: "3.3V" } },
  { sku: "SG90", name: "SG90 Micro Servo", category: "Motors", price: 3.5, cost: 0.9, initial_stock: 120, reorder_point: 30, reorder_qty: 200, supplier: "Shenzhen Parts Co", specs: { torque_kgcm: 1.8, rotation_deg: 180 } },
  { sku: "USB-C-1M", name: "USB-C Cable 1m", category: "Cables", price: 6, cost: 1.5, initial_stock: 200, reorder_point: 40, reorder_qty: 300, supplier: "Shenzhen Parts Co" },
  { sku: "PSU-27W", name: "27W USB-C Power Supply", category: "Power", price: 14, cost: 8, initial_stock: 12, reorder_point: 8, reorder_qty: 30, supplier: "EuroComponents GmbH", specs: { output: "5.1V 5A", plug: "EU" } },
];
for (const p of products) await call("product_upsert", p);

const customers = [
  { name: "Ada Lovelace", email: "ada@makerspace.example", company: "Riverside Makerspace", type: "customer", tags: ["education", "bulk"] },
  { name: "Linus Berg", email: "linus@homelab.example", type: "customer", tags: ["homelab"] },
  { name: "Grace Hopper", email: "grace@robotics-school.example", company: "City Robotics School", type: "lead", tags: ["education"] },
  { name: "Ken Thompson", email: "ken@iotstartup.example", company: "Sensorly", type: "lead", tags: ["b2b"] },
];
for (const c of customers) await call("contact_upsert", c);

const orders: [string, { sku: string; qty: number }[], number, string][] = [
  ["ada@makerspace.example", [{ sku: "ESP32-DEV", qty: 20 }, { sku: "USB-C-1M", qty: 20 }], 75, "delivered"],
  ["linus@homelab.example", [{ sku: "RPI5-8GB", qty: 2 }, { sku: "PSU-27W", qty: 2 }], 40, "delivered"],
  ["ada@makerspace.example", [{ sku: "SG90", qty: 40 }, { sku: "ARD-UNO-R4", qty: 4 }], 20, "delivered"],
  ["linus@homelab.example", [{ sku: "BME280", qty: 3 }], 6, "shipped"],
  ["ada@makerspace.example", [{ sku: "RPI5-8GB", qty: 1 }], 3, "paid"],
];
for (const [email, items, days, status] of orders) {
  const { order } = await call("order_create", { email, items, shipping: 4.9, paid: true, channel: "website" });
  for (const s of ["shipped", "delivered"]) {
    if (status === "paid" || (status === "shipped" && s === "delivered")) break;
    await call("order_update", { order_id: order.id, status: s, carrier: "DHL", tracking_number: `JD0146${order.id}` });
  }
  backdate("orders", Number(order.id), days);
}

const { deal } = await call("deal_create", { title: "40 robotics kits for spring term", email: "grace@robotics-school.example", amount: 2400, stage: "quote_sent", expected_close: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10), next_step: "Confirm kit contents" });
await call("deal_create", { title: "Sensor nodes pilot (200 units)", email: "ken@iotstartup.example", amount: 3800, stage: "qualified", next_step: "Send BME280 + ESP32 bundle pricing" });
db.run("UPDATE deals SET updated_at = datetime('now', '-12 days') WHERE id = 2");

await call("meeting_log", {
  title: "Discovery call — City Robotics School",
  deal_id: deal.id,
  attendees: ["Grace Hopper", "me"],
  summary: "Wants 40 kits (Uno R4 + servos + sensors) delivered before March; budget approved, needs formal quote on school letterhead.",
  decisions: ["Quote Uno R4 based kit", "Offer 8% education discount"],
  action_items: [
    { title: "Send formal quote to Grace", assignee: "me", due_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), priority: "high" },
    { title: "Check Uno R4 availability for 40 units with EuroComponents", assignee: "me" },
  ],
});

await call("ticket_create", { title: "RPi 5 not booting from SD", type: "rma", email: "linus@homelab.example", order_number: "SO-1002", sku: "RPI5-8GB", priority: "high", description: "Red LED only, tried 2 SD cards." });
await call("ticket_create", { title: "Which pins are I2C on the DevKitC?", type: "question", email: "ada@makerspace.example", priority: "low" });

await call("note_upsert", { title: "Returns & warranty policy", tags: ["policy"], body: "- 30-day returns on unopened items.\n- Warranty period per product (default 12 months).\n- DOA units: replace first, then claim from supplier.\n- Customer pays return shipping unless the item is faulty." });
await call("note_upsert", { title: "Bulk & education pricing", tags: ["policy", "pricing"], body: "- 10+ units of one SKU: 5% off.\n- Schools and makerspaces: 8% off, net-30 invoice allowed.\n- Never go below 25% gross margin without approval." });
await call("note_upsert", { title: "How to test a returned Raspberry Pi", tags: ["sop"], body: "1. Inspect for physical damage.\n2. Boot with known-good SD + official PSU.\n3. Check EEPROM bootloader version.\n4. If DOA, open supplier RMA with EuroComponents." });

await call("automation_create", {
  name: "Reorder task on low stock",
  trigger_event: "inventory.low_stock",
  actions: [{ type: "create_task", title: "Reorder {{product.sku}} — {{product.stock_qty}} left", project: "Purchasing", priority: "high", due_in_days: 1 }],
});
await call("automation_create", {
  name: "Ask for a review after delivery",
  trigger_event: "order.status_changed",
  conditions: [{ field: "to", op: "eq", value: "delivered" }],
  actions: [{ type: "create_task", title: "Ask {{contact.name}} for a review of {{order.number}}", due_in_days: 3, project: "Marketing" }],
});

console.error(`Seeded demo shop into ${dbPath}`);
db.close();
