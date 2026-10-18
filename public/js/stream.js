// Live updates for a net page. Tabs share one connection through a SharedWorker (see stream-worker.js).
// Where the browser has no SharedWorker, or the worker cannot start, each tab opens its own EventSource.
const EVENTS = ['net', 'msg', 'del'];

function direct(url, on) {
  const es = new EventSource(url);
  for (const type of EVENTS) es.addEventListener(type, (e) => on(type, JSON.parse(e.data)));
  es.addEventListener('open', () => on('open'));
  return { close: () => es.close() };
}

/**
 * Start listening to one net. `on(type, data)` is called with 'net' (the whole ledger), 'msg' and 'del'
 * (chat), and 'open' (the connection came up). `chat` says whether this person is signed in, which decides
 * which shared connection they join. Returns { close() }.
 */
export function openNetStream(id, chat, on) {
  const url = `/api/nets/${id}/events`;
  if (typeof SharedWorker === 'undefined') return direct(url, on);
  let worker;
  try {
    worker = new SharedWorker('/js/stream-worker.js');
  } catch {
    return direct(url, on);
  }
  const port = worker.port;
  let closed = false;
  let fallback = null;
  const sub = () => port.postMessage({ cmd: 'sub', id, chat });
  const unsub = () => port.postMessage({ cmd: 'unsub', id, chat });
  const restore = (e) => { if (e.persisted && !closed) sub(); }; // back from the browser's back/forward cache
  port.onmessage = (e) => on(e.data.type, e.data.data);
  worker.onerror = () => { if (!closed && !fallback) fallback = direct(url, on); }; // the worker would not load
  globalThis.addEventListener?.('pagehide', unsub); // lets the worker drop this tab's subscription
  globalThis.addEventListener?.('pageshow', restore);
  sub();
  return {
    close() {
      closed = true;
      globalThis.removeEventListener?.('pagehide', unsub);
      globalThis.removeEventListener?.('pageshow', restore);
      unsub();
      port.close();
      fallback?.close();
    },
  };
}
