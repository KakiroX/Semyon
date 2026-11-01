import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type Harness, harness, seedBasics } from "./helpers.js";

describe("semyon MCP server", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    await seedBasics(h);
  });
  afterEach(() => h.close());

  it("exposes tools, resources and prompts", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["product_upsert", "order_create", "deal_pipeline", "ticket_list", "task_board", "meeting_log", "search", "automation_create", "next_actions", "diagram"]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    assert.equal(tools.find((t) => t.name === "search")!.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "note_delete")!.annotations?.destructiveHint, true);

    const { resources } = await h.client.listResources();
    assert.ok(resources.some((r) => r.uri === "semyon://dashboard"));
    const { prompts } = await h.client.listPrompts();
    assert.ok(prompts.some((p) => p.name === "draft_follow_up"));
  });

  it("read-only mode hides every tool that writes", async () => {
    const ro = await harness({ config: { readOnly: true } });
    const { tools } = await ro.client.listTools();
    assert.ok(tools.length > 10);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
    assert.ok(!tools.some((t) => t.name === "order_create"));
    await ro.close();
  });

  it("upserts products and merges specs", async () => {
    const r = await h.call("product_upsert", { sku: "esp32-dev", price: 13, specs: { usb: "micro-B" } });
    assert.equal(r.action, "updated");
    assert.equal(r.product.price, 13);
    assert.deepEqual(r.product.specs, { wifi: "802.11 b/g/n", bluetooth: "4.2", flash_mb: 4, usb: "micro-B" });
    assert.equal(r.product.margin_pct, 69.2);
  });

  it("creates an order: totals, stock reservation, lead promotion, low-stock event", async () => {
    const { order } = await h.call("order_create", {
      email: "ada@example.com",
      items: [
        { sku: "ESP32-DEV", qty: 16 },
        { sku: "USB-C-1M", qty: 2, unit_price: 5 },
      ],
      discount_pct: 10,
      shipping: 5,
      tax_rate: 0.2,
      paid: true,
    });
    // subtotal 200 + 10 = 210; discount 21; taxable 194; tax 38.8; total 232.8
    assert.equal(order.subtotal, 210);
    assert.equal(order.discount, 21);
    assert.equal(order.tax, 38.8);
    assert.equal(order.total, 232.8);
    assert.equal(order.status, "paid");
    assert.equal(order.number, "SO-1001");
    assert.equal(order.gross_profit, 210 - 21 - (16 * 4 + 2 * 1.5));

    const { product } = await h.call("product_get", { sku: "ESP32-DEV" });
    assert.equal(product.stock_qty, 4);
    assert.equal(product.low_stock, true);

    const contact = await h.call("contact_get", { email: "ada@example.com" });
    assert.equal(contact.contact.type, "customer");
    assert.equal(contact.stats.lifetime_value, 232.8);

    const feed = await h.call("activity_feed", { type_prefix: "inventory.low_stock" });
    assert.equal(feed.events.length, 1);
  });

  it("refuses orders beyond stock unless backordered", async () => {
    const err = await h.fail("order_create", { email: "ada@example.com", items: [{ sku: "ESP32-DEV", qty: 21 }] });
    assert.match(err, /Insufficient stock/);
    const { order } = await h.call("order_create", { email: "ada@example.com", items: [{ sku: "ESP32-DEV", qty: 21 }], allow_backorder: true });
    assert.equal(order.status, "pending");
  });

  it("enforces order status transitions and restocks on cancel", async () => {
    const { order } = await h.call("order_create", { email: "ada@example.com", items: [{ sku: "USB-C-1M", qty: 10 }] });
    assert.match(await h.fail("order_update", { number: order.number, status: "shipped" }), /Cannot move/);
    await h.call("order_update", { number: order.number, status: "cancelled" });
    const { product } = await h.call("product_get", { sku: "USB-C-1M" });
    assert.equal(product.stock_qty, 100);
  });

  it("creates new customers inline and links deals (marking them won)", async () => {
    const { deal } = await h.call("deal_create", { title: "Makerspace bulk order", email: "ada@example.com", amount: 500, stage: "quote_sent" });
    assert.equal(deal.weighted_amount, 250);
    const { order } = await h.call("order_create", {
      email: "grace@example.com",
      customer_name: "Grace Hopper",
      items: [{ sku: "USB-C-1M", qty: 1 }],
      deal_id: deal.id,
    });
    assert.equal(order.customer_name, "Grace Hopper");
    const { deal: after } = await h.call("deal_get", { deal_id: deal.id });
    assert.equal(after.stage, "won");
  });

  it("builds the pipeline with weighted forecast and requires a lost reason", async () => {
    const a = (await h.call("deal_create", { title: "A", email: "ada@example.com", amount: 1000, stage: "negotiation" })).deal;
    await h.call("deal_create", { title: "B", amount: 400, stage: "lead" });
    assert.match(await h.fail("deal_update", { deal_id: a.id, stage: "lost" }), /lost_reason/);
    const p = await h.call("deal_pipeline");
    assert.equal(p.totals.open_deals, 2);
    assert.equal(p.totals.weighted_forecast, 750 + 40);
    assert.equal(p.stages.negotiation.count, 1);
  });

  it("checks warranty on RMA tickets and sorts the triage queue", async () => {
    const { order } = await h.call("order_create", { email: "ada@example.com", items: [{ sku: "ESP32-DEV", qty: 1 }], paid: true });
    const rma = await h.call("ticket_create", { title: "Board won't boot", type: "rma", order_number: order.number, sku: "ESP32-DEV", priority: "high" });
    assert.equal(rma.warranty.in_warranty, true);
    assert.equal(rma.ticket.contact_email, "ada@example.com");
    await h.call("ticket_create", { title: "Question about pinout", type: "question", priority: "low" });
    await h.call("ticket_create", { title: "Site down", priority: "urgent" });
    const q = await h.call("ticket_list");
    assert.deepEqual(q.tickets.map((t: any) => t.priority), ["urgent", "high", "low"]);
    assert.match(await h.fail("ticket_update", { ticket_id: rma.ticket.id, status: "resolved" }), /resolution/);
    const done = await h.call("ticket_update", { ticket_id: rma.ticket.id, status: "resolved", resolution: "Replaced unit" });
    assert.ok(done.ticket.resolved_at);
  });

  it("tracks task dependencies, prevents cycles and reports unblocked work", async () => {
    const t1 = (await h.call("task_create", { title: "Photograph new boards", project: "Launch ESP32 kit" })).task;
    const t2 = (await h.call("task_create", { title: "Publish listing", project: "Launch ESP32 kit", depends_on: [t1.id] })).task;
    assert.equal(t2.blocked_by.length, 1);
    assert.match(await h.fail("task_update", { task_id: t2.id, status: "done" }), /waiting on/);
    assert.match(await h.fail("task_update", { task_id: t1.id, add_depends_on: [t2.id] }), /cycle/);
    const r = await h.call("task_update", { task_id: t1.id, status: "done" });
    assert.deepEqual(r.now_unblocked.map((t: any) => t.id), [t2.id]);
    const board = await h.call("task_board", { project: "Launch ESP32 kit" });
    assert.equal(board.columns.todo.length, 1);
    assert.equal(board.columns.done.length, 1);
  });

  it("turns meeting action items into linked tasks", async () => {
    const { deal } = await h.call("deal_create", { title: "School robotics kits", email: "ada@example.com", amount: 2000 });
    const { meeting } = await h.call("meeting_log", {
      title: "Discovery call",
      deal_id: deal.id,
      summary: "Needs 40 kits by March",
      decisions: ["Quote ESP32 + cables bundle"],
      action_items: [{ title: "Send bundle quote", assignee: "me", due_date: "2026-11-05" }, { title: "Check supplier capacity" }],
    });
    assert.equal(meeting.action_items.length, 2);
    assert.equal(meeting.contact_email, "ada@example.com");
    const d = await h.call("deal_get", { deal_id: deal.id });
    assert.equal(d.open_tasks.length, 2);
    assert.ok(d.timeline.some((a: any) => a.kind === "meeting"));
  });

  it("stores knowledge pages and searches across everything", async () => {
    const parent = (await h.call("note_upsert", { title: "Policies", tags: ["policy"] })).note;
    await h.call("note_upsert", { title: "Returns policy", body: "30-day returns on unopened ESP32 boards.", parent_id: parent.id, tags: ["policy"] });
    const s = await h.call("search", { query: "esp32" });
    assert.ok(s.results.products.length === 1);
    assert.ok(s.results.notes[0].snippet.includes("ESP32"));
    const { note } = await h.call("note_get", { note_id: parent.id });
    assert.equal(note.children.length, 1);
    const res = await h.client.readResource({ uri: `semyon://notes/${parent.id + 1}` });
    assert.match((res.contents[0] as { text: string }).text, /^# Returns policy/);
  });

  it("runs automations with conditions, templates and webhooks", async () => {
    const posted: any[] = [];
    const ah = await harness({
      events: {
        fetch: (async (_url: string, init: RequestInit) => {
          posted.push(JSON.parse(String(init.body)));
          return new Response("ok", { status: 200 });
        }) as typeof fetch,
      },
    });
    await seedBasics(ah);
    await ah.call("automation_create", {
      name: "Reorder on low stock",
      trigger_event: "inventory.low_stock",
      actions: [{ type: "create_task", title: "Reorder {{product.sku}} ({{product.stock_qty}} left)", priority: "high", due_in_days: 1, project: "Purchasing" }],
    });
    await ah.call("automation_create", {
      name: "Big order alert",
      trigger_event: "order.created",
      conditions: [{ field: "order.total", op: "gte", value: 100 }],
      actions: [{ type: "webhook", url: "https://hooks.example.com/abc", payload: { text: "Big order {{order.number}} from {{contact.name}}: {{order.total}}" } }],
    });
    await ah.call("order_create", { email: "ada@example.com", items: [{ sku: "USB-C-1M", qty: 1 }] });
    assert.equal(posted.length, 0, "small order should not trigger the webhook");
    await ah.call("order_create", { email: "ada@example.com", items: [{ sku: "ESP32-DEV", qty: 16 }] });
    assert.deepEqual(posted, [{ text: "Big order SO-1002 from Ada Lovelace: 200" }]);

    const board = await ah.call("task_board", { project: "Purchasing" });
    assert.equal(board.columns.todo[0].title, "Reorder ESP32-DEV (4 left)");
    assert.equal(board.columns.todo[0].source, "automation");

    const runs = await ah.call("automation_history");
    assert.equal(runs.runs.length, 2);
    const test = await ah.call("automation_test", { automation_id: 2 });
    assert.deepEqual(test.recent_events.map((e: any) => e.would_run), [true, false]);
    await ah.close();
  });

  it("records failing webhooks without failing the business action", async () => {
    const ah = await harness({ events: { fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch } });
    await seedBasics(ah);
    await ah.call("automation_create", {
      name: "Notify",
      trigger_event: "ticket.created",
      actions: [{ type: "webhook", url: "https://hooks.example.com/x" }],
    });
    const r = await ah.call("ticket_create", { title: "Help" });
    assert.ok(r.ticket.id);
    const runs = await ah.call("automation_history", { errors_only: true });
    assert.match(runs.runs[0].result[0], /HTTP 500/);
    await ah.close();
  });

  it("receives purchase orders into stock and updates cost", async () => {
    const po = await h.call("purchase_order_create", { supplier: "Shenzhen Parts Co", items: [{ sku: "ESP32-DEV", qty: 50, unit_cost: 3.8 }] });
    assert.equal(po.total, 190);
    const inv = await h.call("inventory_report");
    assert.ok(inv.valuation.units > 0);
    await h.call("purchase_order_receive", { po_id: po.id });
    const { product } = await h.call("product_get", { sku: "ESP32-DEV" });
    assert.equal(product.stock_qty, 70);
    assert.equal(product.cost, 3.8);
    assert.match(await h.fail("purchase_order_receive", { po_id: po.id }), /already received/);
  });

  it("produces dashboard, next actions, reports and diagrams", async () => {
    await h.call("order_create", { email: "ada@example.com", items: [{ sku: "ESP32-DEV", qty: 16 }], paid: true });
    await h.call("ticket_create", { title: "Wrong cable shipped", priority: "urgent" });
    const dash = await h.call("business_dashboard", { period_days: 30 });
    assert.equal(dash.sales.orders, 1);
    assert.equal(dash.sales.revenue, 200);
    assert.equal(dash.operations.orders_to_ship, 1);
    assert.equal(dash.operations.low_stock_skus, 1);

    const next = await h.call("next_actions");
    const categories = next.actions.map((a: any) => a.category);
    assert.ok(categories.includes("support") && categories.includes("inventory") && categories.includes("fulfillment"));
    assert.equal(next.actions[0].priority, 1);

    const report = await h.call("sales_report", { group_by: "category" });
    assert.equal(report.rows[0].category, "Microcontrollers");
    assert.equal(report.rows[0].margin_pct, 68);

    const d = await h.call("diagram", { kind: "supply_chain" });
    assert.match(d.diagram, /^flowchart LR/);
    assert.match(d.diagram, /:::low/);
  });

  it("renders prompts with live data", async () => {
    const p = await h.client.getPrompt({ name: "draft_follow_up", arguments: { email: "ada@example.com" } });
    const text = (p.messages[0].content as { text: string }).text;
    assert.match(text, /Ada Lovelace/);
    const w = await h.client.getPrompt({ name: "weekly_review" });
    assert.match((w.messages[0].content as { text: string }).text, /Dashboard/);
  });
});
