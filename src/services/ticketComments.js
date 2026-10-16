import { normalizeAttachments } from './ticketAttachments.js';

export const validCommentId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const identifier = (value) => typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';

export function normalizeComment(raw, fallbackDate) {
  if (!raw || !validCommentId(identifier(raw.id))) return null;
  const createdAt = Number(raw.date ?? fallbackDate);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  const parts = Array.isArray(raw.comment) ? raw.comment : [];
  const hasContent = typeof raw.comment_text === 'string' || typeof raw.text_content === 'string' || Array.isArray(raw.comment);
  const text = typeof raw.comment_text === 'string' ? raw.comment_text
    : typeof raw.text_content === 'string' ? raw.text_content : parts.map((part) => typeof part.text === 'string' ? part.text : '').join('');
  const attachments = normalizeAttachments([
    ...(Array.isArray(raw.attachments) ? raw.attachments : []),
    ...(Array.isArray(raw.email_attachments) ? raw.email_attachments.map((file) => file.attachment || file) : []),
    ...parts.flatMap((part) => [part.attachment, part.image, part.attributes?.['data-attachment']]).filter((file) => file && typeof file === 'object'),
  ]);
  return { id: identifier(raw.id), createdAt, author: typeof raw.user?.username === 'string' ? raw.user.username : 'Usuário do ClickUp',
    text: hasContent ? text : null, attachments };
}

export function extractCommentEvents(payload) {
  if (!validCommentId(payload?.task_id) || !Array.isArray(payload.history_items)) return [];
  const comments = new Map();
  for (const item of payload.history_items) {
    if (item?.field !== 'comment') continue;
    const raw = item.comment || { id: item.after, user: item.user };
    const comment = normalizeComment(raw, item.date);
    if (comment) comments.set(comment.id, { taskId: payload.task_id, comment });
  }
  return [...comments.values()];
}
