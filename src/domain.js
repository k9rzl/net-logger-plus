import crypto from 'node:crypto';

export const MODES = ['FM', 'SSB', 'CW', 'Digital', 'DMR', 'D-STAR', 'Echolink', 'Other'];
export const CALLSIGN_RE = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}(\/[A-Z0-9]{1,4})?$/;
export const RST_RE = /^[1-5][1-9][1-9]?$/; // 59 or 579
const MAX_STATIONS = 500;
const MAX_LOG = 200;
export const MAX_CHECKIN_BATCH = 25;

export const clean = (v, max) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
export const normalizeCallsign = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : '');
export const isCallsign = (v) => CALLSIGN_RE.test(v);

/** Where the operator is, typed by them at registration (for example "Albany, NY"). Shown on the ledger. */
export const normalizeLocation = (v) => clean(v, 60);
export const isLocation = (v) => v.length >= 2 && /\p{L}/u.test(v);

/** The operator's name, typed by them at registration (a first name is fine). Shown on the ledger beside the callsign. */
export const normalizeName = (v) => clean(v, 40);
export const isName = (v) => v.length >= 2 && /\p{L}/u.test(v);

const fail = (error) => ({ ok: false, error });
const ok = () => ({ ok: true });
const find = (net, call) => net.stations.find((s) => s.callsign === call);

function addLog(net, msg, now) {
  net.log.push({ t: now, msg });
  if (net.log.length > MAX_LOG) net.log.splice(0, net.log.length - MAX_LOG);
}

export function createNet(user, input, now = Date.now(), id = crypto.randomBytes(5).toString('hex')) {
  if (!user?.callsign) return fail('Set your callsign before creating a net.');
  const name = clean(input?.name, 60);
  if (name.length < 3) return fail('Net name needs at least 3 characters.');
  if (!MODES.includes(input?.mode)) return fail('Choose a mode.');
  const frequency = clean(input?.frequency, 30);
  if (!frequency) return fail('Enter a frequency or talkgroup.');
  return {
    ok: true,
    net: {
      id,
      name,
      frequency,
      mode: input.mode,
      description: clean(input?.description, 300),
      owner: user.email,
      ownerCall: user.callsign,
      ncs: user.callsign,
      status: 'scheduled',
      createdAt: now,
      startedAt: null,
      closedAt: null,
      seq: 0,
      muted: [],
      stations: [],
      log: [],
    },
  };
}

export function isControl(net, user) {
  if (!user) return false;
  if (user.email === net.owner) return true;
  const ncs = net.ncs && find(net, net.ncs);
  return Boolean(ncs && ncs.email === user.email);
}

/**
 * May this account act on this station? A station checked in by net control has no account yet
 * (email is null); the operator whose callsign it is takes it over the first time they act on it.
 */
function claim(s, user) {
  if (!s || !user?.callsign || s.callsign !== user.callsign) return false;
  if (s.email == null) {
    s.email = user.email;
    if (!s.location && user.location) s.location = user.location;
    if (!s.name && user.name) s.name = user.name;
    return true;
  }
  return s.email === user.email;
}

/**
 * A logger is a checked-in station, signed in to Net Logger Plus, that net control has allowed to add callsigns to
 * the ledger. Loggers can use /ci and nothing else.
 */
export function isLogger(net, user) {
  const s = user?.callsign && find(net, user.callsign);
  return Boolean(s && s.logger && s.state === 'in' && s.email && s.email === user.email);
}

export function join(net, user, now = Date.now()) {
  if (net.status === 'closed') return fail('This net has closed.');
  if (net.status !== 'live') return fail('This net has not started yet.');
  if (!user?.callsign) return fail('Set your callsign first.');
  let s = find(net, user.callsign);
  if (s && !claim(s, user)) return fail(`${user.callsign} is already checked in from another account.`);
  if (s && !s.location && user.location) s.location = user.location;
  if (s && !s.name && user.name) s.name = user.name;
  if (s?.state === 'in') return ok();
  if (!s) {
    if (net.stations.length >= MAX_STATIONS) return fail('This net is full.');
    s = { callsign: user.callsign, email: user.email, location: user.location || null, name: user.name || null, logger: false, state: 'in', hand: false, handAt: null, rst: null, info: null, joinedAt: now, seq: ++net.seq };
    net.stations.push(s);
  } else {
    s.state = 'in';
  }
  addLog(net, `${s.callsign} checked in`, now);
  return ok();
}

export function leave(net, user, now = Date.now()) {
  const s = user?.callsign && find(net, user.callsign);
  if (!s || s.state !== 'in' || !claim(s, user)) return fail('You are not checked in.');
  s.state = 'out';
  s.logger = false; // the role ends when they leave; net control can name them again when they are back
  s.hand = false;
  s.handAt = null;
  addLog(net, `${s.callsign} checked out`, now);
  return ok();
}

export function toggleHand(net, user, now = Date.now()) {
  const s = user?.callsign && find(net, user.callsign);
  if (!s || s.state !== 'in' || !claim(s, user)) return fail('Check in before raising your hand.');
  s.hand = !s.hand;
  s.handAt = s.hand ? now : null;
  addLog(net, `${s.callsign} ${s.hand ? 'raised a hand' : 'lowered a hand'}`, now);
  return ok();
}

/** Every command net control can type. The page shows this list, so keep it in step with runCommand(). */
export const COMMANDS = [
  { usage: '/start', help: 'Open the net so stations can check in.' },
  { usage: '/close', help: 'End the net. Check-ins and chat stop.' },
  { usage: '/ci CALL [CALL ...]', help: 'Check in one or more stations for them (separate callsigns with spaces), for operators who are not using the app.', logger: true },
  { usage: '/co CALL [CALL ...]', help: 'Check one or more stations out. They stay on the ledger marked Out; use /drop to remove an entry.', logger: true },
  { usage: '/logger CALL [CALL ...]', help: 'Let one or more checked-in stations add callsigns to the ledger. They get a LOGGER label and can use only /ci and /co.' },
  { usage: '/rlogger CALL [CALL ...]', help: 'Take the logger role away from one or more stations.' },
  { usage: '/ncs CALL', help: 'Pass net control to a station that is checked in.' },
  { usage: '/ack CALL', help: 'Acknowledge a station and lower its raised hand.' },
  { usage: '/rst CALL 59', help: 'Record a signal report: 59, or 579 for CW (readability 1-5, strength 1-9, tone 1-9).' },
  { usage: '/drop CALL', help: 'Remove a station from the list.' },
  { usage: '/mute CALL', help: 'Stop a station from posting in chat.' },
  { usage: '/unmute CALL', help: 'Let a muted station post in chat again.' },
  { usage: '/note text', help: 'Add a note to the activity log.' },
];
export const COMMAND_HELP = COMMANDS.map((c) => c.usage);

/** The commands a logger may use, taken from the `logger: true` entries above: the single source of truth. */
const LOGGER_COMMANDS = COMMANDS.filter((c) => c.logger).map((c) => c.usage.split(' ')[0]);

/** The commands this person may use on this net: all of them for net control, just /ci for a logger. */
export function commandsFor(net, user) {
  if (isControl(net, user)) return COMMANDS;
  if (isLogger(net, user)) return COMMANDS.filter((c) => c.logger);
  return [];
}

/** Callsigns typed after a command: separated by spaces (commas tolerated), in order, repeats ignored. */
const parseCalls = (rest) => [...new Set(rest.flatMap((t) => t.split(',')).filter(Boolean).map(normalizeCallsign))];
const skippedText = (skipped) => skipped.map(([c, reason]) => `${c} (${reason})`).join(', ');

export function runCommand(net, user, text, now = Date.now()) {
  const [cmdRaw, ...rest] = clean(text, 300).split(' ');
  const cmd = (cmdRaw || '').toLowerCase();
  const control = isControl(net, user);
  const logger = !control && isLogger(net, user);
  if (!control && !(logger && LOGGER_COMMANDS.includes(cmd))) {
    return fail(logger ? `Loggers can only use ${LOGGER_COMMANDS.join(' and ')}.` : 'Only net control can run commands.');
  }
  const call = normalizeCallsign(rest[0]);

  if (net.status === 'closed') return fail('This net has closed.');

  switch (cmd) {
    case '/start':
      if (net.status === 'live') return fail('The net is already live.');
      net.status = 'live';
      net.startedAt = now;
      addLog(net, `Net started by ${user.callsign}`, now);
      return ok();
    case '/close':
      net.status = 'closed';
      net.closedAt = now;
      for (const s of net.stations) { s.hand = false; s.handAt = null; }
      addLog(net, `Net closed by ${user.callsign}`, now);
      return ok();
    case '/ci': {
      // Callsigns separated by spaces (commas are tolerated), checked in in the order typed, duplicates ignored.
      const wanted = parseCalls(rest);
      if (!wanted.length) return fail('Give at least one callsign, for example /ci W1AW K1ABC.');
      if (wanted.length > MAX_CHECKIN_BATCH) return fail(`Check in at most ${MAX_CHECKIN_BATCH} stations at a time.`);
      if (net.status !== 'live') return fail('Start the net before checking stations in.');

      const added = [];
      const skipped = []; // [callsign, reason]
      for (const c of wanted) {
        if (!isCallsign(c)) { skipped.push([c, 'not a valid callsign']); continue; }
        let s = find(net, c);
        if (s?.state === 'in') { skipped.push([c, 'already checked in']); continue; }
        if (!s) {
          if (net.stations.length >= MAX_STATIONS) { skipped.push([c, 'the net is full']); continue; }
          s = { callsign: c, email: null, location: null, name: null, logger: false, addedBy: user.callsign, state: 'in', hand: false, handAt: null, rst: null, info: null, joinedAt: now, seq: ++net.seq };
          net.stations.push(s);
        } else {
          s.state = 'in';
        }
        added.push(c);
      }
      const why = skippedText(skipped);
      if (!added.length) {
        return fail(skipped.length === 1 ? `${skipped[0][0]}: ${skipped[0][1]}.` : `Nobody was checked in. ${why}.`);
      }
      addLog(net, `${added.join(', ')} checked in by ${user.callsign}${control ? '' : ' (logger)'}`, now);
      // The server looks each callsign up on QRZ; `notice` tells net control about anything skipped.
      return { ok: true, stations: added, ...(skipped.length ? { notice: `Checked in ${added.length}. Skipped: ${why}.` } : {}) };
    }
    case '/co': {
      // The same thing the Check out button does for a person, for any station, one or several at a time.
      const wanted = parseCalls(rest);
      if (!wanted.length) return fail('Give at least one callsign, for example /co W1AW K1ABC.');
      if (wanted.length > MAX_CHECKIN_BATCH) return fail(`Check out at most ${MAX_CHECKIN_BATCH} stations at a time.`);
      const out = [];
      const skipped = [];
      for (const c of wanted) {
        const s = isCallsign(c) ? find(net, c) : null;
        if (!isCallsign(c)) skipped.push([c, 'not a valid callsign']);
        else if (!s) skipped.push([c, 'not on the list']);
        // A logger may check out ordinary stations, and themselves, but cannot remove net control or touch
        // another logger's role (checking a station out also ends its logger role).
        else if (!control && (c === net.ncs || (s.email && s.email === net.owner))) skipped.push([c, 'is net control']);
        else if (!control && s.logger && c !== user.callsign) skipped.push([c, 'is a logger, so only net control can check them out']);
        else if (s.state !== 'in') skipped.push([c, 'already checked out']);
        else {
          s.state = 'out';
          s.logger = false; // a logger who is checked out is no longer a logger
          s.hand = false;
          s.handAt = null;
          out.push(c);
        }
      }
      if (!out.length) {
        return fail(skipped.length === 1 ? `${skipped[0][0]}: ${skipped[0][1]}.` : `Nobody was checked out. ${skippedText(skipped)}.`);
      }
      addLog(net, `${out.join(', ')} checked out by ${user.callsign}${control ? '' : ' (logger)'}`, now);
      return { ok: true, ...(skipped.length ? { notice: `Checked out ${out.length}. Skipped: ${skippedText(skipped)}.` } : {}) };
    }
    case '/logger': {
      const wanted = parseCalls(rest);
      if (!wanted.length) return fail('Give at least one callsign, for example /logger W1AW K1ABC.');
      if (wanted.length > MAX_CHECKIN_BATCH) return fail(`Name at most ${MAX_CHECKIN_BATCH} loggers at a time.`);
      const made = [];
      const skipped = [];
      for (const c of wanted) {
        const s = isCallsign(c) ? find(net, c) : null;
        if (!isCallsign(c)) skipped.push([c, 'not a valid callsign']);
        else if (!s || s.state !== 'in') skipped.push([c, 'not checked in']);
        else if (c === net.ncs || (s.email && s.email === net.owner)) skipped.push([c, 'already has full control']);
        else if (s.email == null) skipped.push([c, 'has not signed in to Net Logger Plus yet']);
        else if (s.logger) skipped.push([c, 'already a logger']);
        else { s.logger = true; made.push(c); }
      }
      if (!made.length) {
        return fail(skipped.length === 1 ? `${skipped[0][0]}: ${skipped[0][1]}.` : `Nobody was made a logger. ${skippedText(skipped)}.`);
      }
      addLog(net, `${made.join(', ')} ${made.length > 1 ? 'are now loggers' : 'is now a logger'}`, now);
      return { ok: true, ...(skipped.length ? { notice: `Made ${made.length} logger${made.length > 1 ? 's' : ''}. Skipped: ${skippedText(skipped)}.` } : {}) };
    }
    case '/rlogger': {
      const wanted = parseCalls(rest);
      if (!wanted.length) return fail('Give at least one callsign, for example /rlogger W1AW K1ABC.');
      if (wanted.length > MAX_CHECKIN_BATCH) return fail(`Name at most ${MAX_CHECKIN_BATCH} stations at a time.`);
      const removed = [];
      const skipped = [];
      for (const c of wanted) {
        const s = isCallsign(c) ? find(net, c) : null;
        if (!isCallsign(c)) skipped.push([c, 'not a valid callsign']);
        else if (!s) skipped.push([c, 'not on the list']);
        else if (!s.logger) skipped.push([c, 'not a logger']);
        else { s.logger = false; removed.push(c); }
      }
      if (!removed.length) {
        return fail(skipped.length === 1 ? `${skipped[0][0]}: ${skipped[0][1]}.` : `Nobody was changed. ${skippedText(skipped)}.`);
      }
      addLog(net, `${removed.join(', ')} ${removed.length > 1 ? 'are' : 'is'} no longer ${removed.length > 1 ? 'loggers' : 'a logger'}`, now);
      return { ok: true, ...(skipped.length ? { notice: `Changed ${removed.length}. Skipped: ${skippedText(skipped)}.` } : {}) };
    }
    case '/ncs': {
      const s = find(net, call);
      if (!s || s.state !== 'in') return fail(`${call || 'That station'} is not checked in.`);
      if (s.email == null) return fail(`${call} has not signed in to Net Logger Plus yet, so they cannot be given net control.`);
      net.ncs = call;
      s.logger = false; // net control can do everything a logger can
      addLog(net, `${call} is now net control`, now);
      return ok();
    }
    case '/ack': {
      const s = find(net, call);
      if (!s || !s.hand) return fail(`${call || 'That station'} has no hand raised.`);
      s.hand = false;
      s.handAt = null;
      addLog(net, `${call} acknowledged`, now);
      return ok();
    }
    case '/rst': {
      const s = find(net, call);
      if (!s) return fail(`${call || 'That station'} is not on the list.`);
      if (!RST_RE.test(rest[1] || '')) return fail('Report must look like 59 or 579.');
      s.rst = rest[1];
      addLog(net, `${call} reported ${rest[1]}`, now);
      return ok();
    }
    case '/drop': {
      const i = net.stations.findIndex((s) => s.callsign === call);
      if (i < 0) return fail(`${call || 'That station'} is not on the list.`);
      net.stations.splice(i, 1);
      addLog(net, `${call} removed`, now);
      return ok();
    }
    case '/mute': {
      if (!isCallsign(call)) return fail('Give a callsign, for example /mute W1AW.');
      if (call === net.ownerCall || call === user.callsign) return fail('You cannot mute yourself or the net owner.');
      net.muted ??= [];
      if (net.muted.includes(call)) return fail(`${call} is already muted.`);
      if (net.muted.length >= 200) return fail('Too many muted stations.');
      net.muted.push(call);
      addLog(net, `${call} muted in chat`, now);
      return ok();
    }
    case '/unmute': {
      net.muted ??= [];
      if (!net.muted.includes(call)) return fail(`${call || 'That station'} is not muted.`);
      net.muted = net.muted.filter((c) => c !== call);
      addLog(net, `${call} unmuted in chat`, now);
      return ok();
    }
    case '/note': {
      const note = rest.join(' ');
      if (!note) return fail('Add some text after /note.');
      addLog(net, `Note: ${note}`, now);
      return ok();
    }
    default:
      return fail(`Unknown command. Try: ${COMMAND_HELP.join('  ')}`);
  }
}

/** What anonymous visitors see: no email addresses. */
export function publicView(net) {
  return {
    id: net.id,
    name: net.name,
    frequency: net.frequency,
    mode: net.mode,
    description: net.description,
    ownerCall: net.ownerCall,
    ncs: net.ncs,
    status: net.status,
    createdAt: net.createdAt,
    startedAt: net.startedAt,
    closedAt: net.closedAt,
    stations: net.stations.map(({ email, ...s }) => s),
    log: net.log.slice(-50),
  };
}

export function summary(net) {
  return {
    id: net.id,
    name: net.name,
    frequency: net.frequency,
    mode: net.mode,
    status: net.status,
    ncs: net.ncs,
    checkedIn: net.stations.filter((s) => s.state === 'in').length,
    createdAt: net.createdAt,
  };
}

/** Drop nets that ended (or never started) more than `days` ago, along with their chat. */
export function pruneNets(data, now = Date.now(), days = 30) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [id, n] of Object.entries(data.nets)) {
    const stale = (n.status === 'closed' && n.closedAt < cutoff) || (n.status === 'scheduled' && n.createdAt < cutoff);
    if (stale) {
      delete data.nets[id];
      delete data.chat[id];
      removed += 1;
    }
  }
  return removed;
}
