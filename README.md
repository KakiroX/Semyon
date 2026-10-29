# Semyon — back office MCP server for a small hardware shop

Semyon is a [Model Context Protocol](https://modelcontextprotocol.io) server. It gives Claude (or any MCP client) a full back office for a small business that sells hardware: dev boards, sensors, cables, parts. It covers the product catalog, stock, suppliers and purchase orders, customers and deals, sales orders and shipping, support and RMA tickets, tasks, meeting notes, a knowledge base, and automations.

All data lives in one local SQLite file. There are no accounts to set up and no SaaS subscriptions, and the server works offline.

## How it uses ideas from the popular MCPs

| Inspired by | What it does there | How Semyon applies it |
|---|---|---|
| **Shopify** | Build, manage and analyze a store | Catalog with specs and margins, stock movements, orders that reserve and restock inventory, sales reports, a `product_copy` prompt |
| **HubSpot / Salesforce** | Live CRM context for follow-ups and next actions | Contacts, companies and a deal pipeline with stage probabilities and weighted forecast, a customer 360 view, stale-deal detection, `draft_follow_up` and `account_summary` prompts |
| **Atlassian (Jira)** | Read and update tickets under existing permissions | Support/RMA/warranty tickets with a status workflow, priority SLAs, a triage queue, automatic warranty checks, recurring-fault detection. **Read-only mode** (`SEMYON_READ_ONLY=1`) only exposes tools that don't write |
| **monday.com** | Projects, tasks, dependencies, dashboards | Projects and tasks with owners, due dates, dependency graph (with cycle protection), board view, workload per person |
| **Fellow** | Meeting notes → action items → follow-ups | `meeting_log` turns action items into linked tasks and writes to contact and deal timelines. `meeting_to_actions` prompt |
| **Notion** | Search and update the workspace knowledge | Nested markdown pages for SOPs, policies and supplier terms. One `search` across every record. Pages are also exposed as MCP resources |
| **Zapier** | Glue between apps, automated workflows | Event-driven automations: *when* an event fires, *if* its conditions match, *then* create a task or ticket, log activity, or POST to a webhook (Zapier/Make/n8n catch hooks, Slack incoming webhooks…) |
| **GitHub** | Commit history and changelogs | Every change is an event, so `activity_feed` is a changelog for the business. The `weekly_review` prompt builds an update from it |
| **Figma** | Design context and diagrams | `diagram` creates Mermaid diagrams from live data: deal funnel, order lifecycle, task dependencies, supply chain |

Across all modules, `next_actions` produces a ranked to-do list: urgent tickets, orders to ship, unpaid orders, stock to reorder, late POs, overdue tasks, stale deals, and repeat customers going quiet. `business_dashboard` covers the numbers.

## Quick start

Requires **Node.js ≥ 22.5** (it uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
npm run build
```

Optional: load a demo shop with products, customers, orders, a deal, tickets, policies and automations:

```bash
npm run seed
```

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "semyon": {
      "command": "node",
      "args": ["/absolute/path/to/Semyon/dist/index.js"],
      "env": { "SEMYON_CURRENCY": "EUR", "SEMYON_TAX_RATE": "0.2" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add semyon -- node /absolute/path/to/Semyon/dist/index.js
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SEMYON_DB` | `~/.semyon/semyon.db` | SQLite file (`:memory:` for a throwaway session) |
| `SEMYON_READ_ONLY` | off | Only register tools that never change data. Useful for a bookkeeper or an assistant you only want reporting |
| `SEMYON_CURRENCY` | `USD` | Currency label used in reports |
| `SEMYON_TAX_RATE` | `0` | Default sales tax rate for new orders (e.g. `0.2`) |
| `SEMYON_STALE_DEAL_DAYS` | `7` | Days without a touch before a deal counts as stale |
| `SEMYON_WEBHOOK_TIMEOUT_MS` | `10000` | Timeout for automation webhooks |

## What's inside

**51 tools.** Tools that only read are annotated `readOnlyHint`. Delete and cancel tools are annotated `destructiveHint`, and the delete tools also require `confirm: true`.

- **Catalog & inventory:** `product_upsert`, `product_get`, `product_search`, `inventory_adjust`, `inventory_report` (valuation, reorder suggestions by supplier from sales velocity and lead time, dead stock)
- **Purchasing:** `supplier_upsert`, `supplier_list`, `purchase_order_create`, `purchase_order_receive`, `purchase_order_cancel`, `purchase_order_list`
- **CRM:** `company_upsert`, `contact_upsert`, `contact_get` (customer 360), `contact_search`, `deal_create`, `deal_update`, `deal_get`, `deal_pipeline`, `activity_log`
- **Orders:** `order_create`, `order_update` (enforced status transitions, restock on cancel/refund), `order_get`, `order_list` (`needs_attention` filter)
- **Support:** `ticket_create`, `ticket_update`, `ticket_get`, `ticket_list`
- **Work management:** `project_upsert`, `task_create`, `task_update`, `task_board`
- **Meetings:** `meeting_log`, `meeting_get`, `meeting_list`
- **Knowledge:** `note_upsert`, `note_get`, `note_list`, `note_delete`, `search`
- **Automations:** `automation_create`, `automation_list`, `automation_update`, `automation_delete`, `automation_test` (dry run against real past events), `automation_history`
- **Insights:** `business_dashboard`, `next_actions`, `sales_report`, `activity_feed`, `diagram`

**Resources:** `semyon://dashboard`, `semyon://next-actions`, `semyon://catalog`, `semyon://notes/{id}`

**Prompts:** `draft_follow_up`, `account_summary`, `weekly_review`, `product_copy`, `meeting_to_actions`, `restock_plan`

### Automation examples

Ask Claude in plain language, e.g. *"Whenever something runs low, make me a high-priority reorder task due tomorrow"*. It will call:

```json
{
  "name": "Reorder on low stock",
  "trigger_event": "inventory.low_stock",
  "actions": [{ "type": "create_task", "title": "Reorder {{product.sku}} — {{product.stock_qty}} left", "priority": "high", "due_in_days": 1, "project": "Purchasing" }]
}
```

To post big orders to Slack (or a Zapier catch hook):

```json
{
  "name": "Big order alert",
  "trigger_event": "order.created",
  "conditions": [{ "field": "order.total", "op": "gte", "value": 500 }],
  "actions": [{ "type": "webhook", "url": "https://hooks.slack.com/services/…", "payload": { "text": "💰 {{order.number}} from {{contact.name}}: {{order.total}}" } }]
}
```

Events: `product.created`, `product.updated`, `inventory.adjusted`, `inventory.low_stock`, `purchase_order.created`, `purchase_order.received`, `contact.created`, `deal.created`, `deal.stage_changed`, `order.created`, `order.status_changed`, `ticket.created`, `ticket.status_changed`, `task.completed`, `meeting.logged`. `automation_list` shows the data each one carries. If an automation fails, for example because a webhook is down, the failure is recorded in `automation_history` and the business action still goes through.

## Example things to ask Claude

- "What should I do today?"
- "Ada from the makerspace wants 30 ESP32s and 30 cables at 10% off, paid by card. Book it."
- "Ship SO-1005 with DHL, tracking JD014600005."
- "Linus says his Pi won't boot. Open an RMA and tell me if it's under warranty."
- "Here's the transcript of my call with Grace: … Log it and draft the recap email."
- "Which category makes us the most margin this quarter?"
- "Plan this month's restock and draft the POs."
- "Write a marketplace listing for the BME280."
- "Draw the task dependencies for the 'Launch ESP32 kit' project."

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev
```

The tests in `test/` drive the real server through an in-memory MCP client. The code is laid out as follows:

```
src/
  index.ts        stdio entry point (env config)
  server.ts       registers tools, resources, prompts
  db.ts           SQLite schema + helpers
  events.ts       event log + automation engine
  tools/          one module per domain (catalog, crm, orders, tickets, tasks, meetings, knowledge, automations, insights)
  seed.ts         demo data
```
