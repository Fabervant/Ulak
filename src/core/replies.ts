import { newId } from "./ids";
import { nowIso } from "./time";

export interface ReplyRow {
  id: string;
  message_id: string;
  sender_role: string;
  content: string;
  created_at: string;
}

export const MAX_REPLY = 8000;

export async function addReply(db: D1Database, messageId: string, senderRole: "owner", content: string): Promise<ReplyRow> {
  const text = content.trim();
  if (!text || text.length > MAX_REPLY) throw new Error(`reply must be 1 to ${MAX_REPLY} characters`);
  const row: ReplyRow = { id: newId(), message_id: messageId, sender_role: senderRole, content: text, created_at: nowIso() };
  await db.batch([
    db.prepare("INSERT INTO replies (id,message_id,sender_role,content,created_at) VALUES (?,?,?,?,?)").bind(row.id, row.message_id, row.sender_role, row.content, row.created_at),
    db.prepare("UPDATE messages SET last_activity_at=? WHERE id=?").bind(row.created_at, messageId),
  ]);
  return row;
}

export async function listReplies(db: D1Database, messageId: string): Promise<ReplyRow[]> {
  return (await db.prepare("SELECT * FROM replies WHERE message_id=? ORDER BY created_at, id").bind(messageId).all<ReplyRow>()).results;
}

export async function listRepliesFor(db: D1Database, messageIds: string[]): Promise<Map<string, ReplyRow[]>> {
  const out = new Map<string, ReplyRow[]>();
  if (!messageIds.length) return out;
  const q = `SELECT * FROM replies WHERE message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY created_at, id`;
  for (const r of (await db.prepare(q).bind(...messageIds).all<ReplyRow>()).results) {
    let list = out.get(r.message_id);
    if (!list) {
      list = [];
      out.set(r.message_id, list);
    }
    list.push(r);
  }
  return out;
}
