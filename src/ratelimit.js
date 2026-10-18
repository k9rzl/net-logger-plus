/** Fixed-window in-memory rate limiter. Returns true if the call is allowed. */
export function createLimiter(now = () => Date.now()) {
  const hits = new Map();

  const timer = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, 60_000);
  timer.unref?.();

  return function allow(key, max, windowMs) {
    const t = now();
    const rec = hits.get(key);
    if (!rec || rec.reset <= t) {
      hits.set(key, { count: 1, reset: t + windowMs });
      return true;
    }
    rec.count += 1;
    return rec.count <= max;
  };
}
