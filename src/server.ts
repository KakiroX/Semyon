import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config, Ctx, ToolDef } from "./context.js";
import { Db } from "./db.js";
import { EventBus, type EventBusOptions } from "./events.js";
import { automationTools } from "./tools/automations.js";
import { catalogTools } from "./tools/catalog.js";
import { crmTools } from "./tools/crm.js";
import { dashboard, insightTools, nextActions } from "./tools/insights.js";
import { knowledgeTools } from "./tools/knowledge.js";
import { meetingTools } from "./tools/meetings.js";
import { orderTools } from "./tools/orders.js";
import { taskTools } from "./tools/tasks.js";
import { ticketTools } from "./tools/tickets.js";
import { UserError } from "./util.js";

export const VERSION = "0.1.0";

export const DEFAULT_CONFIG: Config = {
  readOnly: false,
  currency: "USD",
  staleDealDays: 7,
  defaultTaxRate: 0,
};

const INSTRUCTIONS = `Semyon is the back office of a small hardware shop: catalog & inventory, suppliers & purchase orders, CRM (contacts, companies, deals),
sales orders & shipping, support/RMA tickets, tasks & projects, meeting notes, a knowledge base and event-driven automations.

Tips:
- Start with \`next_actions\` or \`business_dashboard\` for "what should I do / how are we doing".
- Use \`search\` when you don't know where something lives; \`contact_get\` before writing to a customer.
- Money is in ${"{currency}"} units (e.g. 19.99), never cents. Dates are YYYY-MM-DD.
- Orders reserve stock on creation; cancellations and refunds restock. Don't also call inventory_adjust for them.
- After a call or meeting, use \`meeting_log\` with extracted action items so they become tracked tasks.
- Repetitive work ("every time X happens, do Y") belongs in \`automation_create\`.`;

export interface ServerOptions {
  dbPath?: string;
  db?: Db;
  config?: Partial<Config>;
  events?: EventBusOptions;
}

export function createContext(opts: ServerOptions = {}): Ctx {
  const db = opts.db ?? new Db(opts.dbPath ?? ":memory:");
  return { db, events: new EventBus(db, opts.events), config: { ...DEFAULT_CONFIG, ...opts.config } };
}

export function allTools(ctx: Ctx): ToolDef[] {
  return [
    ...catalogTools(ctx),
    ...crmTools(ctx),
    ...orderTools(ctx),
    ...ticketTools(ctx),
    ...taskTools(ctx),
    ...meetingTools(ctx),
    ...knowledgeTools(ctx),
    ...automationTools(ctx),
    ...insightTools(ctx),
  ] as unknown as ToolDef[];
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function createServer(opts: ServerOptions = {}): { server: McpServer; ctx: Ctx } {
  const ctx = createContext(opts);
  const server = new McpServer(
    { name: "semyon", version: VERSION },
    { instructions: INSTRUCTIONS.replace("{currency}", ctx.config.currency) },
  );

  const tools = allTools(ctx).filter((t) => !ctx.config.readOnly || t.readOnly);
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: !!tool.readOnly,
          destructiveHint: !!tool.destructive,
          idempotentHint: !!tool.readOnly,
          openWorldHint: tool.name.startsWith("automation") || !tool.readOnly,
        },
      },
      (async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args as never);
          return { content: [{ type: "text", text: json(result) }] };
        } catch (e) {
          const message = e instanceof UserError ? e.message : `Internal error: ${(e as Error).message}`;
          return { content: [{ type: "text", text: message }], isError: true };
        }
      }) as never,
    );
  }

  /** Runs a read-only tool for prompts/resources, returning its JSON output. */
  const read = async (name: string, args: Record<string, unknown>) => {
    const tool = byName.get(name) ?? allTools(ctx).find((t) => t.name === name)!;
    return json(await tool.handler(z.object(tool.input).parse(args) as never));
  };

  // ---- Resources: live context the client can attach without a tool call --------

  server.registerResource(
    "dashboard",
    "semyon://dashboard",
    { title: "Business dashboard (30 days)", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: json(dashboard(ctx, 30)) }] }),
  );

  server.registerResource(
    "next-actions",
    "semyon://next-actions",
    { title: "Next best actions", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: json(nextActions(ctx)) }] }),
  );

  server.registerResource(
    "catalog",
    "semyon://catalog",
    { title: "Active product catalog", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: await read("product_search", { status: "active", limit: 200 }) }] }),
  );

  server.registerResource(
    "knowledge-page",
    new ResourceTemplate("semyon://notes/{id}", {
      list: async () => ({
        resources: ctx.db
          .all<{ id: number; title: string }>("SELECT id, title FROM notes ORDER BY title")
          .map((n) => ({ uri: `semyon://notes/${n.id}`, name: n.title, mimeType: "text/markdown" })),
      }),
    }),
    { title: "Knowledge base page", mimeType: "text/markdown" },
    async (uri, { id }) => {
      const note = ctx.db.get<{ title: string; body: string }>("SELECT title, body FROM notes WHERE id = ?", Number(id));
      if (!note) throw new Error(`Note ${id} not found`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: `# ${note.title}\n\n${note.body}` }] };
    },
  );

  // ---- Prompts: reusable workflows ------------------------------------------------

  const userPrompt = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

  server.registerPrompt(
    "draft_follow_up",
    {
      title: "Draft customer follow-up",
      description: "Draft a follow-up email to a contact using their full history (orders, deals, tickets, meetings).",
      argsSchema: { email: z.string(), goal: z.string().optional() },
    },
    async ({ email, goal }) =>
      userPrompt(
        `Draft a short, friendly follow-up email to this customer${goal ? ` with this goal: ${goal}` : ""}. ` +
          `Reference specifics from their history (recent orders, open deals, tickets, last meeting and its action items). ` +
          `Propose one clear next step. Don't invent facts that aren't in the data. After I approve it, log it with activity_log (kind=email).\n\n` +
          `Customer record:\n${await read("contact_get", { email })}`,
      ),
  );

  server.registerPrompt(
    "account_summary",
    {
      title: "Account summary",
      description: "Summarize a customer account: value, health, open issues, and recommended next actions.",
      argsSchema: { email: z.string() },
    },
    async ({ email }) =>
      userPrompt(
        `Summarize this account in under 200 words: who they are, what they buy, lifetime value and order cadence, open deals and tickets, ` +
          `risks, and the 3 most valuable next actions.\n\n${await read("contact_get", { email })}`,
      ),
  );

  server.registerPrompt(
    "weekly_review",
    { title: "Weekly business review", description: "A weekly review of sales, operations and priorities for the week ahead." },
    async () =>
      userPrompt(
        `Write my weekly business review. Sections: Headline numbers (vs previous week), What happened (from the changelog), ` +
          `Problems to fix, Top priorities this week (from next actions). Be concrete and brief.\n\n` +
          `## Dashboard (7 days)\n${json(dashboard(ctx, 7))}\n\n## Changelog\n${await read("activity_feed", { limit: 200 })}\n\n` +
          `## Next actions\n${json(nextActions(ctx, 15))}`,
      ),
  );

  server.registerPrompt(
    "product_copy",
    {
      title: "Write product copy",
      description: "Write a product listing (title, bullets, description, spec table) from the catalog record.",
      argsSchema: {
        sku: z.string(),
        channel: z.string().optional().describe("website, marketplace, social..."),
        tone: z.string().optional(),
      },
    },
    async ({ sku, channel, tone }) =>
      userPrompt(
        `Write a product listing for ${channel ?? "our website"}${tone ? ` in a ${tone} tone` : ""}: an SEO-friendly title, 5 benefit-led bullets, ` +
          `a 120-word description and a spec table built only from the specs below. Mention the warranty. ` +
          `If I approve, save the description with product_upsert.\n\n${await read("product_get", { sku })}`,
      ),
  );

  server.registerPrompt(
    "meeting_to_actions",
    {
      title: "Meeting notes → actions",
      description: "Turn raw meeting notes or a transcript into a summary, decisions and tracked action items.",
      argsSchema: { notes: z.string(), email: z.string().optional() },
    },
    async ({ notes, email }) =>
      userPrompt(
        `From these meeting notes, extract: a 2-3 sentence summary, decisions, and action items (owner + due date when stated). ` +
          `Then call meeting_log${email ? ` with email=${email}` : ""} to record it, and offer to draft the recap email.\n\n---\n${notes}`,
      ),
  );

  server.registerPrompt(
    "restock_plan",
    { title: "Restock plan", description: "Turn the inventory report into purchase orders per supplier." },
    async () =>
      userPrompt(
        `Review this inventory report and propose purchase orders per supplier (SKU, qty, est. cost, reasoning). ` +
          `Flag dead stock we should discount. Ask me before creating any PO with purchase_order_create.\n\n${await read("inventory_report", {})}`,
      ),
  );

  return { server, ctx };
}
