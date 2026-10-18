import crypto from 'node:crypto';
import { clean } from './domain.js';

export const MAX_MESSAGES = 200;
export const MAX_TEXT = 500;

export const messages = (store, netId) => (store.data.chat[netId] ??= []);

export function postMessage(store, net, user, text, now = Date.now()) {
  if (!user?.callsign) return { ok: false, error: 'Set your callsign to use chat.' };
  if (net.status === 'closed') return { ok: false, error: 'This net has closed. Chat is read-only.' };
  if ((net.muted ?? []).includes(user.callsign)) return { ok: false, error: 'Net control has muted you in this net.' };
  const body = clean(text, MAX_TEXT);
  if (!body) return { ok: false, error: 'Type a message first.' };
  const list = messages(store, net.id);
  const msg = { id: crypto.randomBytes(5).toString('hex'), t: now, call: user.callsign, text: body };
  list.push(msg);
  if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
  return { ok: true, msg };
}

export function deleteMessage(store, netId, msgId) {
  const list = messages(store, netId);
  const i = list.findIndex((m) => m.id === msgId);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}
