import { api } from './api.js';
import { openNetStream } from './stream.js';

const root = document.getElementById('app');
let me = { user: null, devLinks: false };
let streams = [];
let poll = null;

/** Build DOM nodes. Children are always inserted as text, never as HTML. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Registration is complete once a person has given a callsign, a name and a location. */
const profileComplete = (u) => Boolean(u && u.callsign && u.name && u.location);

/**
 * The line under a callsign on the ledger: the name and location the operator typed at registration. QRZ,
 * when it is set up, fills in either one for stations checked in by net control, who have no profile.
 * Draws nothing when there is nothing to say.
 */
const opLine = (station) => {
  const place = station.location || station.info?.location;
  const text = [station.name || station.info?.name, place].filter(Boolean).join(' · ');
  return text ? h('div', { class: 'op' }, text) : null;
};

function teardown() {
  streams.forEach((s) => s.close());
  streams = [];
  clearInterval(poll);
  poll = null;
}

function msgLine() {
  return h('p', { class: 'msg', role: 'status' });
}
function say(el, text, isError = false) {
  el.textContent = text;
  el.className = isError ? 'msg error' : 'msg';
}

async function run(el, fn) {
  try {
    say(el, '');
    await fn();
  } catch (e) {
    say(el, e.message, true);
  }
}

const lamp = (status) =>
  h('span', { class: `lamp ${status}`, title: status }, h('span', { class: 'sr' }, status));

function header() {
  const right = me.user
    ? [
        h('span', { class: 'who' }, me.user.callsign || me.user.email),
        h('button', {
          class: 'quiet',
          type: 'button',
          onclick: async () => { await api('POST', '/api/auth/logout', {}); await boot(); },
        }, 'Sign out'),
      ]
    : [];
  return h('header', { class: 'bar' }, h('a', { class: 'brand', href: '#/' }, 'Net Logger Plus'), h('div', { class: 'bar-right' }, right));
}

/* ---------- Home ---------- */

function loginCard() {
  const note = msgLine();
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com' });
  const out = h('div');
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      run(note, async () => {
        const r = await api('POST', '/api/auth/request', { email: email.value });
        out.replaceChildren();
        if (r.devLink) {
          out.append(h('p', {}, 'Dev mode: open your sign-in link'), h('a', { href: r.devLink }, 'Sign in now'));
        } else {
          say(note, 'If that address can receive mail, a sign-in link is on its way. It works once.');
        }
      });
    },
  },
    h('label', { for: 'email' }, 'Email address'),
    h('div', { class: 'row' }, email, h('button', { class: 'primary', type: 'submit' }, 'Email me a sign-in link')),
  );
  return h('section', { class: 'card' }, h('h2', {}, 'Sign in to check in'), form, note, out,
    h('p', { class: 'fine' }, 'You can watch any net without signing in.'));
}

/** The callsign, name and location form, used for registration and later for editing. */
function profileForm(user, submitLabel) {
  const note = msgLine();
  const call = h('input', { id: 'call', autocomplete: 'off', autocapitalize: 'characters', maxlength: '12', required: true, placeholder: 'W1AW', value: user?.callsign || '' });
  const who = h('input', { id: 'pname', autocomplete: 'given-name', maxlength: '40', required: true, placeholder: 'Hiram', value: user?.name || '' });
  const place = h('input', { id: 'loc', autocomplete: 'off', maxlength: '60', required: true, placeholder: 'Albany, NY', value: user?.location || '' });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      run(note, async () => { await api('POST', '/api/me', { callsign: call.value, name: who.value, location: place.value }); await boot(); });
    },
  },
    h('label', { for: 'call' }, 'Callsign'), call,
    h('label', { for: 'pname' }, 'Name'), who,
    h('label', { for: 'loc' }, 'Location'), place,
    h('p', { class: 'fine' }, 'Your name and location are shown next to your callsign on the ledger of every net you join. A first name is fine. Use a city or region (for example Albany, NY), not a street address.'),
    h('button', { class: 'primary', type: 'submit' }, submitLabel),
  );
  return [form, note];
}

function profileCard() {
  return h('section', { class: 'card' },
    h('h2', {}, 'Set your callsign, name and location'),
    ...profileForm(me.user, 'Save callsign, name and location'),
    h('p', { class: 'fine' }, 'Callsigns are not verified against a licence database. Operators of this instance decide who to trust.'),
  );
}

function profileDetails() {
  return h('details', { class: 'card' }, h('summary', {}, 'Your profile'), ...profileForm(me.user, 'Update profile'));
}

function createNetCard() {
  const note = msgLine();
  const name = h('input', { id: 'nn', required: true, maxlength: '60', placeholder: 'Tuesday Evening Net' });
  const freq = h('input', { id: 'nf', required: true, maxlength: '30', placeholder: '146.520 MHz' });
  const mode = h('select', { id: 'nm' }, ['FM', 'SSB', 'CW', 'Digital', 'DMR', 'D-STAR', 'Echolink', 'Other'].map((m) => h('option', { value: m }, m)));
  const desc = h('input', { id: 'nd', maxlength: '300', placeholder: 'Optional: who it is for, check-in rules' });
  return h('details', { class: 'card' },
    h('summary', {}, 'Create a net'),
    h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        run(note, async () => {
          const r = await api('POST', '/api/nets', { name: name.value, frequency: freq.value, mode: mode.value, description: desc.value });
          location.hash = `#/net/${r.id}`;
        });
      },
    },
      h('label', { for: 'nn' }, 'Name'), name,
      h('div', { class: 'row split' },
        h('div', {}, h('label', { for: 'nf' }, 'Frequency or talkgroup'), freq),
        h('div', {}, h('label', { for: 'nm' }, 'Mode'), mode)),
      h('label', { for: 'nd' }, 'Description'), desc,
      h('button', { class: 'primary', type: 'submit' }, 'Create net'),
    ),
    note,
  );
}

async function renderHome() {
  const list = h('ul', { class: 'nets' });
  const page = h('main', { class: 'wrap' },
    h('h1', {}, 'Nets on the air'),
    list,
    ...(!me.user ? [loginCard()] : !profileComplete(me.user) ? [profileCard()] : [createNetCard(), profileDetails()]),
  );
  root.replaceChildren(header(), page);

  async function load() {
    try {
      const { nets } = await api('GET', '/api/nets');
      list.replaceChildren(...(nets.length
        ? nets.map((n) => h('li', {},
            h('a', { href: `#/net/${n.id}`, class: 'net-row' },
              lamp(n.status),
              h('span', { class: 'net-name' }, n.name),
              h('span', { class: 'dial' }, `${n.frequency} · ${n.mode}`),
              h('span', { class: 'count' }, n.status === 'live' ? `${n.checkedIn} in` : n.status))))
        : [h('li', { class: 'empty' }, 'No nets yet. Create one below, then start it when you are ready to go on air.')]));
    } catch (e) {
      list.replaceChildren(h('li', { class: 'empty error' }, e.message));
    }
  }
  await load();
  poll = setInterval(load, 10_000);
}

/* ---------- Net page ---------- */

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function renderNet(id) {
  let data;
  try {
    data = await api('GET', `/api/nets/${id}`);
  } catch (e) {
    root.replaceChildren(header(), h('main', { class: 'wrap' }, h('p', { class: 'msg error' }, e.message), h('a', { href: '#/' }, 'Back to all nets')));
    return;
  }

  let net = data.net;
  let canControl = data.canControl;
  let canLog = data.canLog; // net control, or a logger: may add and remove callsigns with /ci and /co
  let commands = data.commands || [];

  const title = h('h1', {});
  const dial = h('p', { class: 'dial-big' });
  const about = h('p', { class: 'about' });
  const actions = h('div', { class: 'actions' });
  const note = msgLine();
  const body = h('tbody');
  const log = h('ol', { class: 'log' });

  const cmdInput = h('input', { id: 'cmd', autocomplete: 'off', placeholder: '/rst W1AW 59', maxlength: '300' });
  // These four are filled in by paint(): net control and loggers see different headings and commands.
  const cmdTitle = h('h2', {});
  const cmdRef = h('dl', { class: 'cmd-ref' });
  const cmdRole = h('p', { class: 'fine' });
  const cmdLabel = h('label', { for: 'cmd' });
  const cmdForm = h('form', {
    class: 'cmd',
    onsubmit: (e) => {
      e.preventDefault();
      run(note, async () => {
        const r = await api('POST', `/api/nets/${id}/command`, { text: cmdInput.value });
        cmdInput.value = '';
        if (r.notice) say(note, r.notice); // not an error: some callsigns were skipped
      });
    },
  },
    cmdTitle,
    cmdRole,
    cmdRef,
    cmdLabel,
    h('div', { class: 'row' }, cmdInput, h('button', { class: 'primary', type: 'submit' }, 'Run')),
  );

  /* ----- Chat (signed-in operators with a callsign) ----- */
  let chatMsgs = [];
  const chatList = h('ol', { class: 'chat-list', 'aria-live': 'polite' });
  const chatInput = h('input', { id: 'chat', maxlength: '500', autocomplete: 'off', placeholder: 'Message the net' });
  const chatNote = msgLine();
  const chatBox = h('section', { class: 'chat' },
    h('h2', {}, 'Net chat'),
    chatList,
    h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const text = chatInput.value;
        run(chatNote, async () => { await api('POST', `/api/nets/${id}/chat`, { text }); chatInput.value = ''; });
      },
    },
      h('label', { class: 'sr', for: 'chat' }, 'Chat message'),
      h('div', { class: 'row' }, chatInput, h('button', { class: 'primary', type: 'submit' }, 'Send'))),
    chatNote);
  chatBox.hidden = !profileComplete(me.user);

  function paintChat() {
    chatList.replaceChildren(...(chatMsgs.length
      ? chatMsgs.map((m) => h('li', {},
          h('time', {}, fmtTime(m.t)), ' ', h('strong', { class: 'mcall' }, m.call), ' ', m.text,
          canControl ? h('button', {
            type: 'button', class: 'link', 'aria-label': `Remove message from ${m.call}`,
            onclick: () => run(chatNote, () => api('DELETE', `/api/nets/${id}/chat/${m.id}`)),
          }, 'Remove') : null))
      : [h('li', { class: 'empty' }, 'No messages yet.')]));
    chatList.scrollTop = chatList.scrollHeight;
  }
  const addMsg = (m) => {
    if (!chatMsgs.some((x) => x.id === m.id)) chatMsgs = [...chatMsgs, m].slice(-100);
  };

  const post = (action) => () => run(note, () => api('POST', `/api/nets/${id}/${action}`, {}));
  const btn = (label, fn, cls = '') => h('button', { type: 'button', class: cls, onclick: fn }, label);

  function paint() {
    title.replaceChildren(lamp(net.status), ' ', net.name);
    dial.textContent = `${net.frequency}  ${net.mode}`;
    about.textContent = [net.description, `Opened by ${net.ownerCall}`, net.ncs ? `Net control: ${net.ncs}` : ''].filter(Boolean).join('  ·  ');

    const mine = me.user?.callsign && net.stations.find((s) => s.callsign === me.user.callsign);
    const checkedIn = mine?.state === 'in';
    const a = [];
    if (net.status === 'closed') a.push(h('span', { class: 'fine' }, 'This net has closed.'));
    else if (!me.user) a.push(h('span', { class: 'fine' }, 'Sign in from the home page to check in.'));
    else if (!profileComplete(me.user)) a.push(h('span', { class: 'fine' }, 'Set your callsign, name and location on the home page to check in.'));
    else if (net.status === 'live') {
      a.push(checkedIn ? btn('Check out', post('leave')) : btn('Check in', post('join'), 'primary'));
      if (checkedIn) a.push(btn(mine.hand ? 'Lower hand' : 'Raise hand', post('hand')));
    }
    if (canControl && net.status === 'scheduled') a.push(btn('Start net', () => run(note, () => api('POST', `/api/nets/${id}/command`, { text: '/start' })), 'primary'));
    if (canControl && net.status === 'live') a.push(btn('Close net', () => run(note, () => api('POST', `/api/nets/${id}/command`, { text: '/close' }))));
    actions.replaceChildren(...a);

    const rows = [...net.stations].sort((x, y) => {
      if (x.state !== y.state) return x.state === 'in' ? -1 : 1;
      if (x.hand !== y.hand) return x.hand ? -1 : 1;
      if (x.hand && y.hand) return x.handAt - y.handAt;
      return x.seq - y.seq;
    });
    body.replaceChildren(...(rows.length
      ? rows.map((s) => h('tr', { class: `${s.state} ${s.callsign === net.ncs ? 'ncs' : ''} ${s.state === 'in' && s.hand ? 'hand' : ''}` },
          h('td', { class: 'n' }, s.seq),
          h('td', { class: 'call' }, s.callsign,
            s.callsign === net.ncs ? h('span', { class: 'tag' }, 'NCS') : s.logger ? h('span', { class: 'tag logger' }, 'LOGGER') : null,
            opLine(s)),
          h('td', { class: s.state === 'in' && s.hand ? 'hand-up' : '' }, s.state === 'out' ? 'Out' : s.hand ? [h('span', { 'aria-hidden': 'true' }, '✋'), ' Hand up'] : 'In'),
          h('td', { class: 'rst' }, s.rst || '')))
      : [h('tr', {}, h('td', { colspan: '4', class: 'empty' }, net.status === 'live' ? 'No check-ins yet.' : 'Check-ins open when net control starts the net.'))]));

    log.replaceChildren(...net.log.slice().reverse().slice(0, 30).map((l) => h('li', {}, h('time', {}, fmtTime(l.t)), ' ', l.msg)));
    cmdForm.hidden = !(canControl || canLog) || net.status === 'closed';
    cmdTitle.textContent = canControl ? 'Net control commands' : 'Logger commands';
    cmdLabel.textContent = canControl ? 'Net control command' : 'Logger command';
    cmdInput.placeholder = canControl ? '/rst W1AW 59' : '/ci W1AW K1ABC';
    cmdRole.textContent = canControl ? '' : 'Net control has made you a logger for this net: you can add stations to the ledger with /ci and check them out with /co.';
    cmdRole.hidden = canControl;
    cmdRef.replaceChildren(...commands.flatMap((c) => [h('dt', {}, c.usage), h('dd', {}, c.help)]));
    paintChat();
  }

  root.replaceChildren(header(),
    h('main', { class: 'wrap' },
      h('a', { href: '#/', class: 'back' }, 'All nets'),
      title, dial, about, actions, note,
      h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Order'), h('th', { scope: 'col' }, 'Callsign'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Report'))),
        body),
      cmdForm,
      chatBox,
      h('h2', {}, 'Activity'), log));
  paint();

  if (profileComplete(me.user)) {
    api('GET', `/api/nets/${id}/chat`).then((d) => { d.messages.forEach(addMsg); chatMsgs.sort((a, b) => a.t - b.t); paintChat(); }).catch((e) => say(chatNote, e.message, true));
  }

  // Live updates: net updates for everyone, plus chat for signed-in viewers. Tabs of this browser share one connection.
  let opened = false;
  streams.push(openNetStream(id, profileComplete(me.user), (type, d) => {
    if (type === 'msg') {
      addMsg(d);
      paintChat();
    } else if (type === 'del') {
      chatMsgs = chatMsgs.filter((m) => m.id !== d.id);
      paintChat();
    } else if (type === 'open') {
      // After a dropped connection, pick up any chat messages sent while we were away.
      if (opened && profileComplete(me.user)) {
        api('GET', `/api/nets/${id}/chat`).then((r) => { r.messages.forEach(addMsg); chatMsgs.sort((a, b) => a.t - b.t); paintChat(); }).catch(() => {});
      }
      opened = true;
    } else if (type === 'net') {
      net = d;
      // Roles can change while the page is open (net control reassigned, a logger named or removed): refresh quietly.
      api('GET', `/api/nets/${id}`).then((r) => { canControl = r.canControl; canLog = r.canLog; commands = r.commands || []; paint(); }).catch(() => paint());
    }
  }));
}

/* ---------- Router ---------- */

async function render() {
  teardown();
  const m = location.hash.match(/^#\/net\/([a-f0-9]{10})$/);
  if (m) await renderNet(m[1]);
  else await renderHome();
}

async function boot() {
  try { me = await api('GET', '/api/me'); } catch { me = { user: null, devLinks: false }; }
  await render();
}

window.addEventListener('hashchange', render);
boot();
