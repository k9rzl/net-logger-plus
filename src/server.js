import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv, ROOT } from './config.js';
import { Store } from './store.js';
import { createAuth, normalizeEmail } from './auth.js';
import { createLimiter } from './ratelimit.js';
import { createHub } from './sse.js';
import * as domain from './domain.js';
import * as chat from './chat.js';
import { MongoStore } from './mongostore.js';
import { createQrz } from './qrz.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MIN = 60_000;
const NET_ORDER = { live: 0, scheduled: 1, closed: 2 };

export function createApp({ config, store, auth, sendMail, qrz = createQrz({}) }) {
  const allow = createLimiter();
  const hub = createHub();
  const PUBLIC_DIR = path.join(ROOT, 'public');

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1]; // appended by our one trusted proxy
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const limit = (key, max, windowMs) => {
    if (!allow(key, max, windowMs)) throw new HttpError(429, 'Too many requests. Wait a bit and try again.');
  };

  function setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Send JSON.');
    }
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 10_000) throw new HttpError(413, 'Request too large.');
      chunks.push(c);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  /** CSRF: state-changing calls need a custom header (forces CORS preflight) and a same-origin Origin. */
  function checkCsrf(req) {
    if (req.headers['x-net-logger-plus'] !== '1') throw new HttpError(403, 'Missing request header.');
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Bad origin.'); }
      if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
    }
  }

  const requireUser = (req) => {
    const s = auth.sessionFromCookie(req.headers.cookie);
    if (!s) throw new HttpError(401, 'Sign in first.');
    return s;
  };

  /** Registration is complete only with a callsign, a name and a location. */
  const requireProfile = (req) => {
    const s = requireUser(req);
    if (!s.user.callsign || !s.user.name || !s.user.location) {
      throw new HttpError(403, 'Finish your profile first: add your callsign, name and location on the home page.');
    }
    return s;
  };

  const getNet = (id) => {
    const net = store.data.nets[id];
    if (!net) throw new HttpError(404, 'Net not found.');
    return net;
  };

  const changed = (net) => {
    store.save();
    hub.publish(net.id, 'net', domain.publicView(net));
  };

  // QRZ details arrive one by one. Broadcast them in a single update shortly after the first, rather
  // than sending every viewer a full copy of the ledger per callsign.
  const soon = new Map();
  const changedSoon = (net) => {
    if (soon.has(net.id)) return;
    const timer = setTimeout(() => {
      soon.delete(net.id);
      changed(net);
    }, 150);
    timer.unref?.();
    soon.set(net.id, timer);
  };

  const act = (result) => {
    if (!result.ok) throw new HttpError(400, result.error);
  };

  const routes = [];
  const route = (method, pattern, handler) => routes.push([method, new RegExp(`^${pattern}$`), handler]);

  route('GET', '/api/me', (req, res) => {
    const s = auth.sessionFromCookie(req.headers.cookie);
    json(res, 200, {
      user: s ? { email: s.email, callsign: s.user.callsign, name: s.user.name ?? null, location: s.user.location ?? null } : null,
      devLinks: config.devLinks,
    });
  });

  route('POST', '/api/auth/request', async (req, res, _m, ip) => {
    limit(`authreq:ip:${ip}`, 8, 15 * MIN);
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (!email) throw new HttpError(400, 'Enter a valid email address.');
    limit(`authreq:email:${email}`, 3, 15 * MIN);

    const token = auth.issueToken(email);
    const link = `${config.baseUrl}/verify.html#${token}`;
    try {
      await sendMail({ to: email, subject: 'Your Net Logger Plus sign-in link', text: `Sign in to Net Logger Plus (valid 15 minutes, one use):\n\n${link}\n\nIf you did not ask for this, ignore this email.` });
    } catch (e) {
      console.error('mail failed:', e.message);
    }
    // Same response whether or not delivery worked: no account/address probing.
    json(res, 200, { ok: true, ...(config.devLinks ? { devLink: link } : {}) });
  });

  route('POST', '/api/auth/verify', async (req, res, _m, ip) => {
    limit(`verify:ip:${ip}`, 20, 15 * MIN);
    const body = await readJson(req);
    const email = auth.consumeToken(body.token);
    if (!email) throw new HttpError(400, 'This sign-in link is invalid or expired. Request a new one.');
    res.setHeader('Set-Cookie', auth.sessionCookie(auth.createSession(email)));
    json(res, 200, { ok: true });
  });

  route('POST', '/api/auth/logout', (req, res) => {
    const live = auth.sessionFromCookie(req.headers.cookie);
    if (live) hub.dropSession(live.id);
    auth.destroySession(req.headers.cookie);
    res.setHeader('Set-Cookie', auth.clearCookie());
    json(res, 200, { ok: true });
  });

  route('POST', '/api/me', async (req, res) => {
    const s = requireUser(req);
    limit(`profile:${s.email}`, 10, 15 * MIN);
    const body = await readJson(req);
    const call = domain.normalizeCallsign(body.callsign);
    if (!domain.isCallsign(call)) throw new HttpError(400, 'That does not look like a callsign (example: W1AW).');
    const who = domain.normalizeName(body.name);
    if (!domain.isName(who)) throw new HttpError(400, 'Enter your name, for example "Hiram".');
    const place = domain.normalizeLocation(body.location);
    if (!domain.isLocation(place)) {
      throw new HttpError(400, 'Enter your location, for example "Albany, NY" or "Ottawa, Canada".');
    }
    if (qrz.enabled) {
      const r = await qrz.lookup(call);
      if (config.qrzRequire && r.status === 'notfound') throw new HttpError(400, `QRZ has no record of ${call}.`);
      if (config.qrzRequire && r.status === 'unavailable') throw new HttpError(503, 'Callsign lookup is unavailable right now. Try again shortly.');
    }
    const taken = Object.values(store.data.users).some((u) => u.callsign === call && u.email !== s.email);
    if (taken) throw new HttpError(409, `${call} is already registered to another account.`);
    s.user.callsign = call;
    s.user.name = who;
    s.user.location = place;
    // Keep the ledgers of nets still running in step with an edited name or location.
    for (const net of Object.values(store.data.nets)) {
      if (net.status === 'closed') continue;
      let touched = false;
      for (const st of net.stations) {
        if (st.email === s.email && st.callsign === call && (st.location !== place || st.name !== who)) {
          st.location = place;
          st.name = who;
          touched = true;
        }
      }
      if (touched) changed(net);
    }
    store.save();
    json(res, 200, { user: { email: s.email, callsign: call, name: who, location: place } });
  });

  route('GET', '/api/nets', (req, res) => {
    const cutoff = Date.now() - 24 * 60 * MIN;
    const nets = Object.values(store.data.nets)
      .filter((n) => n.status !== 'closed' || n.closedAt > cutoff)
      .sort((a, b) => NET_ORDER[a.status] - NET_ORDER[b.status] || b.createdAt - a.createdAt) // live, then scheduled, then closed; newest first within each
      .map(domain.summary);
    json(res, 200, { nets });
  });

  route('POST', '/api/nets', async (req, res) => {
    const s = requireProfile(req);
    limit(`create:${s.email}`, 10, 60 * MIN);
    const body = await readJson(req);
    const r = domain.createNet(s.user, body);
    act(r);
    if (Object.keys(store.data.nets).length >= 2000) throw new HttpError(503, 'This instance has reached its net limit.');
    store.data.nets[r.net.id] = r.net;
    store.save();
    json(res, 201, { id: r.net.id });
  });

  route('GET', '/api/nets/([a-f0-9]{10})', (req, res, m) => {
    const net = getNet(m[1]);
    const s = auth.sessionFromCookie(req.headers.cookie);
    const viewer = s?.user && { ...s.user, email: s.email };
    const canControl = domain.isControl(net, viewer);
    json(res, 200, {
      net: domain.publicView(net),
      canControl,
      canLog: canControl || domain.isLogger(net, viewer), // may add callsigns with /ci
      commands: domain.commandsFor(net, viewer), // only what this person may actually use
    });
  });

  // One live stream per page. Everyone receives the net's updates; chat messages ride on the same
  // connection but only for signed-in viewers (browsers allow few connections per site over HTTP/1.1).
  route('GET', '/api/nets/([a-f0-9]{10})/events', (req, res, m, ip) => {
    const net = getNet(m[1]);
    const s = auth.sessionFromCookie(req.headers.cookie);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const channels = s ? [net.id, `chat:${net.id}`] : [net.id];
    if (!hub.add(channels, res, ip, s?.id ?? null)) {
      res.end();
      return;
    }
    res.write(`retry: 3000\nevent: net\ndata: ${JSON.stringify(domain.publicView(net))}\n\n`);
  });

  const netAction = (name, fn) =>
    route('POST', `/api/nets/([a-f0-9]{10})/${name}`, async (req, res, m) => {
      const s = requireProfile(req);
      limit(`act:${s.email}`, 120, MIN);
      const net = getNet(m[1]);
      const user = { ...s.user, email: s.email };
      const extra = await fn(net, user, req);
      changed(net);
      json(res, 200, { ok: true, ...(extra || {}) });
    });

  /** Attach QRZ name/location to a station without delaying the check-in itself. */
  function enrich(net, call) {
    if (!qrz.enabled) return;
    qrz.lookup(call).then((r) => {
      const st = net.stations.find((x) => x.callsign === call);
      // QRZ can know a callsign but return nothing we can show (a free account gets fewer fields): skip those.
      if (r.status === 'found' && st && (r.info.name || r.info.location)) {
        st.info = { name: r.info.name, location: r.info.location };
        changedSoon(net);
      }
    });
  }

  netAction('join', (net, user) => {
    act(domain.join(net, user));
    enrich(net, user.callsign);
  });
  netAction('leave', (net, user) => act(domain.leave(net, user)));
  netAction('hand', (net, user) => act(domain.toggleHand(net, user)));
  netAction('command', async (net, user, req) => {
    const body = await readJson(req);
    const r = domain.runCommand(net, user, body.text);
    act(r);
    for (const call of r.stations ?? []) enrich(net, call); // QRZ name and location for each, without waiting
    return r.notice ? { notice: r.notice } : undefined; // e.g. which callsigns /ci skipped
  });

  /* ---------- Chat (signed-in users only) ---------- */

  route('GET', '/api/nets/([a-f0-9]{10})/chat', (req, res, m) => {
    requireUser(req);
    const net = getNet(m[1]);
    json(res, 200, { messages: chat.messages(store, net.id).slice(-100) });
  });

  route('POST', '/api/nets/([a-f0-9]{10})/chat', async (req, res, m) => {
    const s = requireProfile(req);
    limit(`chat:${s.email}`, 20, MIN);
    const net = getNet(m[1]);
    const body = await readJson(req);
    const r = chat.postMessage(store, net, { ...s.user, email: s.email }, body.text);
    act(r);
    store.save();
    hub.publish(`chat:${net.id}`, 'msg', r.msg);
    json(res, 201, { ok: true });
  });

  route('DELETE', '/api/nets/([a-f0-9]{10})/chat/([a-f0-9]{10})', (req, res, m) => {
    const s = requireUser(req);
    limit(`act:${s.email}`, 120, MIN);
    const net = getNet(m[1]);
    if (!domain.isControl(net, { ...s.user, email: s.email })) throw new HttpError(403, 'Only net control can remove messages.');
    if (!chat.deleteMessage(store, net.id, m[2])) throw new HttpError(404, 'Message not found.');
    store.save();
    hub.publish(`chat:${net.id}`, 'del', { id: m[2] });
    json(res, 200, { ok: true });
  });

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Bad path.'); }
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new HttpError(404, 'Not found.');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  return async function handler(req, res) {
    setSecurityHeaders(res);
    const ip = clientIp(req);
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') checkCsrf(req);
        for (const [method, re, fn] of routes) {
          const m = re.exec(pathname);
          if (m && method === req.method) return await fn(req, res, m, ip);
        }
        throw new HttpError(404, 'Not found.');
      }
      serveStatic(req, res, pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error(e);
      json(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}

function makeMailer(config) {
  return async ({ to, subject, text }) => {
    if (!config.mailWebhookUrl) {
      // No mail relay configured: the operator can read the link in the server log.
      console.log(`\n[mail to ${to}] ${subject}\n${text}\n`);
      return;
    }
    const r = await fetch(config.mailWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.mailWebhookToken ? { authorization: `Bearer ${config.mailWebhookToken}` } : {}),
      },
      body: JSON.stringify({ to, subject, text }),
    });
    if (!r.ok) throw new Error(`mail relay returned ${r.status}`);
  };
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const store = config.mongoUri
    ? await MongoStore.connect({ uri: config.mongoUri, dbName: config.mongoDb })
    : new Store(config.dataFile);
  const auth = createAuth({ store, secret: config.secret, secureCookie: config.secureCookie });
  const qrz = createQrz({ username: config.qrzUsername, password: config.qrzPassword, baseUrl: config.qrzBaseUrl });
  const app = createApp({ config, store, auth, sendMail: makeMailer(config), qrz });

  const prune = () => {
    if (domain.pruneNets(store.data)) store.save();
  };
  prune();
  setInterval(prune, 60 * 60 * 1000).unref();

  if (config.production && config.plainHttp) {
    console.warn(
      `WARNING: BASE_URL is ${config.baseUrl} (plain HTTP). Sign-in links and session cookies travel unencrypted; ` +
        'anyone on the network path can take over accounts. Use HTTPS unless this is a trusted network.',
    );
  }

  const server = http.createServer(app);
  server.listen(config.port, config.host, () => {
    const bits = [config.mongoUri ? 'MongoDB' : 'JSON file', qrz.enabled ? 'QRZ on' : 'QRZ off', config.devLinks ? 'DEV_LINKS on' : null];
    console.log(`Net Logger Plus listening on ${config.host}:${config.port}, public URL ${config.baseUrl}  (${bits.filter(Boolean).join(', ')})`);
  });
  const stop = async () => {
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
