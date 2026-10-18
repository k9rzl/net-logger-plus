/**
 * Server-Sent Events fan-out. A connection can listen to several channels at once (a net page needs the
 * net's updates and, for signed-in viewers, its chat), so each page holds a single connection.
 */
export function createHub({ maxPerIp = 30 } = {}) {
  const channels = new Map(); // netId -> Set<res>
  const perIp = new Map();

  function add(channelNames, res, ip, sessionId = null) {
    if ((perIp.get(ip) || 0) >= maxPerIp) return false;
    perIp.set(ip, (perIp.get(ip) || 0) + 1); // counted once per connection, however many channels
    res.nlSession = sessionId;
    const names = [].concat(channelNames);
    for (const name of names) {
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name).add(res);
    }
    res.on('close', () => {
      for (const name of names) channels.get(name)?.delete(res);
      perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
    });
    return true;
  }

  function publish(netId, event, payload) {
    const set = channels.get(netId);
    if (!set) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) res.write(msg);
  }

  const beat = setInterval(() => {
    for (const set of channels.values()) for (const res of set) res.write(': ping\n\n');
  }, 25_000);
  beat.unref?.();

  /** End every stream opened by a session (used on logout). */
  function dropSession(sessionId) {
    for (const set of channels.values()) for (const res of set) if (res.nlSession === sessionId) res.end();
  }

  return { add, publish, dropSession, count: () => [...channels.values()].reduce((n, s) => n + s.size, 0) };
}
