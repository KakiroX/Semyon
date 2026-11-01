import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import { assert, findById, parseJson, present, updateRow } from "../util.js";

/**
 * Knowledge base and workspace search — modeled on the Notion MCP: SOPs,
 * pricing policies, supplier terms and FAQs in nested pages, plus one search
 * across every record in the business.
 */

export function knowledgeTools(ctx: Ctx) {
  const { db } = ctx;

  function getNote(id: number) {
    const n = findById(db, "notes", id, "Note");
    return {
      ...present(n, ["tags"]),
      parent: n.parent_id ? db.get("SELECT id, title FROM notes WHERE id = ?", Number(n.parent_id)) : null,
      children: db.all("SELECT id, title, updated_at FROM notes WHERE parent_id = ? ORDER BY title", id),
    };
  }

  return [
    defineTool({
      name: "note_upsert",
      title: "Create or update knowledge page",
      description:
        "Write a knowledge-base page (markdown): SOPs (how we test returned boards), policies (returns, warranty, bulk pricing), supplier terms, FAQs, " +
        "canned replies. Pass note_id to update; `append` adds to the end instead of replacing the body. Pages can be nested via parent_id.",
      input: {
        note_id: z.number().int().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        append: z.boolean().default(false),
        tags: z.array(z.string()).optional(),
        parent_id: z.number().int().nullable().optional(),
      },
      handler: (a) => {
        if (a.parent_id) findById(db, "notes", a.parent_id, "Parent note");
        if (a.note_id) {
          const existing = findById(db, "notes", a.note_id, "Note");
          assert(a.parent_id !== a.note_id, "A page cannot be its own parent");
          const body = a.body !== undefined && a.append ? `${existing.body}\n\n${a.body}` : a.body;
          updateRow(db, "notes", a.note_id, { title: a.title, body, tags: a.tags, parent_id: a.parent_id });
          return { action: "updated", note: getNote(a.note_id) };
        }
        assert(a.title, "title is required when creating a page");
        const id = db.run(
          "INSERT INTO notes (title, body, tags, parent_id) VALUES (?, ?, ?, ?)",
          a.title,
          a.body ?? "",
          JSON.stringify(a.tags ?? []),
          a.parent_id ?? null,
        ).id;
        return { action: "created", note: getNote(id) };
      },
    }),

    defineTool({
      name: "note_get",
      title: "Read knowledge page",
      description: "Read a knowledge-base page with its parent and child pages.",
      readOnly: true,
      input: { note_id: z.number().int() },
      handler: (a) => ({ note: getNote(a.note_id) }),
    }),

    defineTool({
      name: "note_list",
      title: "List knowledge pages",
      description: "The knowledge-base page tree, optionally filtered by tag.",
      readOnly: true,
      input: { tag: z.string().optional() },
      handler: (a) => {
        const rows = a.tag
          ? db.all(
              "SELECT id, title, parent_id, tags, updated_at FROM notes WHERE EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ? COLLATE NOCASE) ORDER BY title",
              a.tag,
            )
          : db.all("SELECT id, title, parent_id, tags, updated_at FROM notes ORDER BY title");
        return { notes: rows.map((r) => ({ ...r, tags: parseJson(r.tags, []) })) };
      },
    }),

    defineTool({
      name: "note_delete",
      title: "Delete knowledge page",
      description: "Permanently delete a knowledge-base page. Child pages are kept and moved to the top level. Requires confirm=true.",
      destructive: true,
      input: { note_id: z.number().int(), confirm: z.literal(true) },
      handler: (a) => {
        const n = findById(db, "notes", a.note_id, "Note");
        db.run("DELETE FROM notes WHERE id = ?", a.note_id);
        return { deleted: { id: n.id, title: n.title } };
      },
    }),

    defineTool({
      name: "search",
      title: "Search everything",
      description:
        "One search across products, contacts, companies, deals, orders, tickets, tasks, meetings and knowledge pages. " +
        "Start here when you don't know where something lives.",
      readOnly: true,
      input: {
        query: z.string().min(2),
        limit_per_type: z.number().int().min(1).max(50).default(5),
      },
      handler: (a) => {
        const q = `%${a.query}%`;
        const n = a.limit_per_type;
        const results = {
          products: db.all("SELECT id, sku, name, stock_qty, status FROM products WHERE sku LIKE ? OR name LIKE ? OR description LIKE ? OR specs LIKE ? LIMIT ?", q, q, q, q, n),
          contacts: db.all("SELECT id, name, email, type FROM contacts WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR notes LIKE ? LIMIT ?", q, q, q, q, n),
          companies: db.all("SELECT id, name, domain FROM companies WHERE name LIKE ? OR domain LIKE ? OR notes LIKE ? LIMIT ?", q, q, q, n),
          deals: db.all("SELECT id, title, stage FROM deals WHERE title LIKE ? OR next_step LIKE ? LIMIT ?", q, q, n),
          orders: db.all(
            "SELECT id, number, status FROM orders WHERE number LIKE ? OR tracking_number LIKE ? OR notes LIKE ? OR shipping_address LIKE ? LIMIT ?",
            q, q, q, q, n,
          ),
          tickets: db.all("SELECT id, title, status, priority FROM tickets WHERE title LIKE ? OR description LIKE ? OR resolution LIKE ? LIMIT ?", q, q, q, n),
          tasks: db.all("SELECT id, title, status, due_date FROM tasks WHERE title LIKE ? OR description LIKE ? LIMIT ?", q, q, n),
          meetings: db.all("SELECT id, title, held_at FROM meetings WHERE title LIKE ? OR notes LIKE ? OR summary LIKE ? LIMIT ?", q, q, q, n),
          notes: db
            .all("SELECT id, title, body FROM notes WHERE title LIKE ? OR body LIKE ? OR tags LIKE ? LIMIT ?", q, q, q, n)
            .map((r) => ({ id: r.id, title: r.title, snippet: snippet(String(r.body), a.query) })),
          activities: db.all("SELECT entity_type, entity_id, kind, body, created_at FROM activities WHERE body LIKE ? ORDER BY id DESC LIMIT ?", q, n),
        };
        const total = Object.values(results).reduce((s, r) => s + r.length, 0);
        return { query: a.query, total, results: Object.fromEntries(Object.entries(results).filter(([, r]) => r.length > 0)) };
      },
    }),
  ];
}

function snippet(text: string, query: string, radius = 80): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text.slice(0, radius * 2);
  return (i > radius ? "…" : "") + text.slice(Math.max(0, i - radius), i + query.length + radius) + (i + query.length + radius < text.length ? "…" : "");
}
