// Shared live-update connection. Every tab of this browser that watches the same net talks to this one
// worker, and the worker holds a single EventSource per net. Browsers allow only six connections per site
// over plain HTTP/1.1, so one stream per tab stalls buttons once about five tabs are open.
//
// Signed-in viewers also receive chat on their stream, so they are kept on a separate connection from
// visitors: "chat" is part of the key. A browser has at most two connections per net, however many tabs.
const hubs = new Map(); // "netId:chat" -> { es, ports: Set, last }

function join(key, id, port) {
  let hub = hubs.get(key);
  if (!hub) {
    hub = { ports: new Set(), last: null, es: new EventSource(`/api/nets/${id}/events`) };
    const send = (type, data) => hub.ports.forEach((p) => p.postMessage({ type, data }));
    for (const type of ['net', 'msg', 'del']) {
      hub.es.addEventListener(type, (e) => {
        const data = JSON.parse(e.data);
        if (type === 'net') hub.last = data; // the newest ledger, for tabs that join later
        send(type, data);
      });
    }
    hub.es.addEventListener('open', () => send('open'));
    hubs.set(key, hub);
  }
  hub.ports.add(port);
  if (hub.last) port.postMessage({ type: 'net', data: hub.last }); // a new tab sees the net at once
}

function leave(key, port) {
  const hub = hubs.get(key);
  if (!hub) return;
  hub.ports.delete(port);
  if (!hub.ports.size) {
    hub.es.close(); // nobody is watching this net any more
    hubs.delete(key);
  }
}

globalThis.onconnect = (e) => {
  const port = e.ports[0];
  const mine = new Set();
  port.onmessage = (m) => {
    const { cmd, id, chat } = m.data || {};
    if (!/^[a-f0-9]{10}$/.test(String(id))) return;
    const key = `${id}:${chat ? 1 : 0}`;
    if (cmd === 'sub' && !mine.has(key)) {
      mine.add(key);
      join(key, id, port);
    } else if (cmd === 'unsub' && mine.delete(key)) {
      leave(key, port);
    }
  };
};
