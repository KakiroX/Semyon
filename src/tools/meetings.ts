import { z } from "zod";
import { type Ctx, defineTool } from "../context.js";
import { assert, findById, findContact, logActivity, nowSql, parseJson, present } from "../util.js";

/**
 * Meeting notes and action items — modeled on the Fellow MCP: what was
 * discussed becomes tasks, timeline entries and follow-up drafts.
 */

export function meetingTools(ctx: Ctx) {
  const { db, events } = ctx;

  function getMeeting(id: number) {
    const m = db.get(
      `SELECT m.*, c.name AS contact_name, c.email AS contact_email, d.title AS deal_title
       FROM meetings m LEFT JOIN contacts c ON c.id = m.contact_id LEFT JOIN deals d ON d.id = m.deal_id WHERE m.id = ?`,
      id,
    );
    assert(m, `Meeting #${id} not found`);
    return {
      ...present(m, ["attendees", "decisions"]),
      action_items: db.all("SELECT id, title, assignee, due_date, status FROM tasks WHERE meeting_id = ? ORDER BY id", id),
    };
  }

  return [
    defineTool({
      name: "meeting_log",
      title: "Log meeting",
      description:
        "Record a customer call, supplier meeting or team sync. Paste notes or a transcript plus your summary, decisions and action items. " +
        "Each action item becomes a task linked to the meeting (and to the deal/contact). The meeting is added to the contact and deal timelines. " +
        "Extract action items from the transcript yourself before calling.",
      input: {
        title: z.string().min(1),
        held_at: z.string().optional().describe("YYYY-MM-DD or YYYY-MM-DD HH:MM; defaults to now"),
        attendees: z.array(z.string()).default([]),
        email: z.string().optional().describe("External contact the meeting was with"),
        contact_id: z.number().int().optional(),
        deal_id: z.number().int().optional(),
        notes: z.string().optional().describe("Raw notes or transcript"),
        summary: z.string().optional(),
        decisions: z.array(z.string()).default([]),
        action_items: z
          .array(
            z.object({
              title: z.string(),
              assignee: z.string().optional(),
              due_date: z.string().optional(),
              priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
            }),
          )
          .default([]),
        project: z.string().optional().describe("Project to file the action items under"),
      },
      handler: async (a) => {
        const contact = a.contact_id || a.email ? findContact(db, a) : undefined;
        const deal = a.deal_id ? findById(db, "deals", a.deal_id, "Deal") : undefined;
        const contactId = (contact?.id ?? deal?.contact_id ?? null) as number | null;
        const meetingId = db.tx(() => {
          const id = db.run(
            "INSERT INTO meetings (title, held_at, attendees, contact_id, deal_id, notes, summary, decisions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            a.title,
            a.held_at ?? nowSql(),
            JSON.stringify(a.attendees),
            contactId,
            a.deal_id ?? null,
            a.notes ?? null,
            a.summary ?? null,
            JSON.stringify(a.decisions),
          ).id;
          let projectId: number | null = null;
          if (a.project) {
            projectId =
              db.get<{ id: number }>("SELECT id FROM projects WHERE name = ? COLLATE NOCASE", a.project)?.id ??
              db.run("INSERT INTO projects (name) VALUES (?)", a.project).id;
          }
          const [relType, relId] = a.deal_id ? ["deal", a.deal_id] : contactId ? ["contact", contactId] : [null, null];
          for (const item of a.action_items) {
            db.run(
              `INSERT INTO tasks (project_id, title, priority, assignee, due_date, related_type, related_id, meeting_id, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'meeting')`,
              projectId,
              item.title,
              item.priority ?? "medium",
              item.assignee ?? null,
              item.due_date ?? null,
              relType,
              relId,
              id,
            );
          }
          const line = `Meeting "${a.title}"${a.summary ? `: ${a.summary}` : ""}`;
          if (contactId) logActivity(db, "contact", contactId, "meeting", line);
          if (a.deal_id) logActivity(db, "deal", a.deal_id, "meeting", line);
          return id;
        });
        const meeting = getMeeting(meetingId);
        await events.emit("meeting.logged", { type: "meeting", id: meetingId }, `Meeting: ${a.title}`, {
          meeting,
          action_items: meeting.action_items,
        });
        return {
          meeting,
          follow_up_hint: contact
            ? `Use the draft_follow_up prompt (or contact_get) to write a recap email to ${contact.name} <${contact.email ?? "no email"}>.`
            : undefined,
        };
      },
    }),

    defineTool({
      name: "meeting_get",
      title: "Get meeting",
      description: "A meeting with notes, decisions and the live status of its action items.",
      readOnly: true,
      input: { meeting_id: z.number().int() },
      handler: (a) => ({ meeting: getMeeting(a.meeting_id) }),
    }),

    defineTool({
      name: "meeting_list",
      title: "List meetings",
      description: "Recent meetings with how many action items are still open. Filter by contact or deal.",
      readOnly: true,
      input: {
        email: z.string().optional(),
        contact_id: z.number().int().optional(),
        deal_id: z.number().int().optional(),
        open_action_items_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      handler: (a) => {
        const where: string[] = [];
        const params: number[] = [];
        if (a.email || a.contact_id) {
          where.push("m.contact_id = ?");
          params.push(Number(findContact(db, a).id));
        }
        if (a.deal_id) {
          where.push("m.deal_id = ?");
          params.push(a.deal_id);
        }
        const having = a.open_action_items_only ? "HAVING open_action_items > 0" : "";
        const rows = db.all(
          `SELECT m.id, m.title, m.held_at, m.summary, m.attendees, c.name AS contact_name,
                  COALESCE(SUM(t.status != 'done'), 0) AS open_action_items, COUNT(t.id) AS action_items
           FROM meetings m LEFT JOIN contacts c ON c.id = m.contact_id LEFT JOIN tasks t ON t.meeting_id = m.id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY m.id ${having} ORDER BY m.held_at DESC LIMIT ?`,
          ...params,
          a.limit,
        );
        return { meetings: rows.map((r) => ({ ...r, attendees: parseJson(r.attendees, []) })) };
      },
    }),
  ];
}
