import { test, expect } from 'playwright/test';

/* ---------- helpers ---------- */

// Random start so a restarted worker never reuses callsigns the server already holds.
let counter = Math.floor(Math.random() * 500);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Unique, valid callsigns: K1AA, K1AB, ... (one account per callsign on the server). */
const nextCall = () => {
  const n = counter++;
  return `K1${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}`;
};
const nextEmail = (tag) => `${tag}-${counter}-${Math.random().toString(36).slice(2, 8)}@example.org`;

/** Anything here fails the test: uncaught page errors and Content-Security-Policy violations. */
const problems = [];
function track(page) {
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
  });
}
let ipSeq = 0;
const nextIp = () => `10.2.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
test.beforeEach(async ({ page }) => {
  // The server rate-limits sign-ins per client IP, so every test presents a distinct one.
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': nextIp() });
  track(page);
});
test.afterEach(() => {
  const found = problems.splice(0);
  expect(found, found.join('\n')).toEqual([]);
});

/** A separate browser context = a separate person. Each gets its own client IP for rate limiting. */
async function newPerson(browser) {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:3200',
    extraHTTPHeaders: { 'x-forwarded-for': nextIp() },
  });
  const page = await context.newPage();
  track(page);
  return { context, page };
}

async function requestLink(page, email) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  const link = page.getByRole('link', { name: 'Sign in now' });
  await expect(link).toBeVisible();
  return link;
}

async function signIn(page, callsign = nextCall(), email = nextEmail('op'), location = 'Albany, NY', name = 'Pat') {
  const link = await requestLink(page, email);
  await link.click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set your callsign' })).toBeVisible();
  await page.getByLabel('Callsign').fill(callsign);
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Location').fill(location);
  await page.getByRole('button', { name: 'Save callsign, name and location' }).click();
  await expect(page.locator('.bar .who')).toHaveText(callsign);
  return callsign;
}

async function createNet(page, name) {
  await page.getByText('Create a net').click();
  await page.locator('#nn').fill(name);
  await page.getByLabel('Frequency or talkgroup').fill('146.520 MHz');
  await page.getByLabel('Mode').selectOption('FM');
  await page.getByRole('button', { name: 'Create net' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
  return page.url();
}

const startNet = async (page) => {
  await page.getByRole('button', { name: 'Start net' }).click();
  await expect(page.locator('h1 .lamp.live')).toBeVisible();
};
const row = (page, call) => page.getByRole('row').filter({ hasText: call });
const chatBox = (page) => page.locator('section.chat');
const say = async (page, text) => {
  await page.getByLabel('Chat message').fill(text);
  await chatBox(page).getByRole('button', { name: 'Send' }).click();
};
const run = async (page, command) => {
  await page.getByLabel('Net control command').fill(command);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
};

/* ---------- tests ---------- */

test('home page loads with strict security headers and an empty state', async ({ page, request }) => {
  const res = await request.get('/');
  expect(res.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Nets on the air' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to check in' })).toBeVisible();
});

test('sign in with a magic link, set a callsign, sign out', async ({ page }) => {
  const call = await signIn(page);
  await expect(page.getByText('Create a net')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to check in' })).toBeVisible();
  await expect(page.locator('.bar .who')).toHaveCount(0);
  expect(call).toMatch(/^K1[A-Z]{2}$/);
});

test('a sign-in link works exactly once', async ({ page, browser }) => {
  const link = await requestLink(page, nextEmail('once'));
  const href = await link.getAttribute('href');
  await link.click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set your callsign' })).toBeVisible();

  const other = await newPerson(browser);
  await other.page.goto(href);
  await other.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(other.page.locator('#msg')).toContainText(/invalid or expired/i);
  await other.context.close();
});

test('the verify button ships disabled so it cannot be pressed before its script is ready', async ({ request }) => {
  const html = await (await request.get('/verify.html')).text();
  expect(html).toMatch(/<button id="go"[^>]*\bdisabled\b/);
});

test('verify page without a token explains itself and cannot be submitted', async ({ page }) => {
  await page.goto('/verify.html');
  await expect(page.locator('#msg')).toContainText('full link from your email');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled();
});

test('rejects a malformed callsign with a clear message', async ({ page }) => {
  const link = await requestLink(page, nextEmail('bad'));
  await link.click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Callsign').fill('HELLO');
  await page.getByLabel('Name', { exact: true }).fill('Pat');
  await page.getByLabel('Location').fill('Albany, NY');
  await page.getByRole('button', { name: 'Save callsign, name and location' }).click();
  await expect(page.locator('.msg.error')).toContainText(/does not look like a callsign/i);
});

test('full net: create, start, check in, and QRZ details appear live', async ({ page }) => {
  const call = await signIn(page);
  await createNet(page, 'Tuesday Evening Net');
  await expect(page.getByText('Check-ins open when net control starts the net.')).toBeVisible();

  await startNet(page);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();

  const mine = row(page, call);
  await expect(mine).toContainText('In');
  await expect(mine).toContainText('NCS');
  // QRZ enrichment arrives over the live stream a moment later; private fields never do.
  await expect(mine).toContainText('Pat · Albany, NY'); // name from QRZ, location typed at registration
  await expect(page.locator('body')).not.toContainText('Secret Street');
  await expect(page.locator('body')).not.toContainText('private@example.org');
  await expect(page.locator('.log')).toContainText(`${call} checked in`);
});

test('two operators see each other live: check-in, hand, acknowledge, signal report', async ({ page, browser }) => {
  const alice = await signIn(page);
  const url = await createNet(page, 'Live Sync Net');
  await startNet(page);

  const bobP = await newPerson(browser);
  const bob = await signIn(bobP.page);
  await bobP.page.goto(url);
  await expect(bobP.page.getByRole('heading', { level: 1 })).toContainText('Live Sync Net');

  await bobP.page.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(row(page, bob)).toContainText('In'); // Alice never reloaded

  await bobP.page.getByRole('button', { name: 'Raise hand' }).click();
  await expect(row(page, bob)).toContainText('Hand up');

  await run(page, `/ack ${bob}`);
  await expect(row(page, bob)).not.toContainText('Hand up');
  await expect(row(bobP.page, bob)).toContainText('In');

  await run(page, `/rst ${bob} 59`);
  await expect(row(bobP.page, bob).locator('.rst')).toHaveText('59');

  // Bob is not net control: he has no command box and the server would refuse him anyway.
  await expect(bobP.page.getByLabel('Net control command')).toBeHidden();
  expect(alice).not.toBe(bob);

  await bobP.page.getByRole('button', { name: 'Check out' }).click();
  await expect(row(page, bob)).toContainText('Out');
  await bobP.context.close();
});

test('control rules: bad command shows an error, close ends the net for everyone', async ({ page, browser }) => {
  await signIn(page);
  const url = await createNet(page, 'Closing Net');
  await startNet(page);

  await run(page, '/rst NOBODY 59');
  await expect(page.locator('main > .msg')).toContainText(/not on the list/i);
  await run(page, '/bogus');
  await expect(page.locator('main > .msg')).toContainText(/Unknown command/i);

  const watcher = await newPerson(browser);
  await watcher.page.goto(url);
  await expect(watcher.page.locator('h1 .lamp.live')).toBeVisible();

  await page.getByRole('button', { name: 'Close net' }).click();
  await expect(watcher.page.locator('h1 .lamp.closed')).toBeVisible(); // anonymous viewer updated live
  await expect(watcher.page.getByText('This net has closed.')).toBeVisible();
  await watcher.context.close();
});

test('chat: live delivery, history on reload, removal by net control, mute', async ({ page, browser }) => {
  await signIn(page);
  const url = await createNet(page, 'Chatty Net');
  await startNet(page);

  const bobP = await newPerson(browser);
  const bob = await signIn(bobP.page);
  await bobP.page.goto(url);

  await say(bobP.page, 'Good evening from Bob');
  await expect(chatBox(page).locator('.chat-list')).toContainText('Good evening from Bob');
  await expect(chatBox(page).locator('.chat-list')).toContainText(bob);
  await expect(chatBox(bobP.page).getByRole('button', { name: /Remove message/ })).toHaveCount(0); // not control

  await page.reload(); // history is loaded from the server, not just the live stream
  await expect(chatBox(page).locator('.chat-list')).toContainText('Good evening from Bob');

  await chatBox(page).getByRole('button', { name: /Remove message from/ }).click();
  await expect(chatBox(page).locator('.chat-list')).not.toContainText('Good evening from Bob');
  await expect(chatBox(bobP.page).locator('.chat-list')).not.toContainText('Good evening from Bob');

  await run(page, `/mute ${bob}`);
  await say(bobP.page, 'Can anyone hear me?');
  await expect(chatBox(bobP.page).locator('.msg')).toContainText(/muted/i);
  await expect(chatBox(page).locator('.chat-list')).not.toContainText('Can anyone hear me?');

  await run(page, `/unmute ${bob}`);
  await say(bobP.page, 'Back again');
  await expect(chatBox(page).locator('.chat-list')).toContainText('Back again');
  await bobP.context.close();
});

test('anonymous visitors can watch but see no chat, lookup, or check-in controls', async ({ page, browser }) => {
  await signIn(page);
  const url = await createNet(page, 'Public Net');
  await startNet(page);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();

  const anon = await newPerson(browser);
  await anon.page.goto(url);
  await expect(anon.page.getByRole('heading', { level: 1 })).toContainText('Public Net');
  await expect(anon.page.getByRole('table')).toBeVisible();
  await expect(anon.page.getByText('Sign in from the home page to check in.')).toBeVisible();
  await expect(anon.page.locator('section.chat')).toBeHidden();
  await expect(anon.page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0);

  const api = await anon.context.request.get('/api/nets');
  expect(JSON.stringify(await api.json())).not.toContain('@');
  await anon.context.close();
});

test('user-supplied text is rendered as text, never as HTML', async ({ page }) => {
  await signIn(page);
  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await createNet(page, `Net ${payload}`.slice(0, 60));
  await startNet(page);
  await say(page, payload);

  await expect(chatBox(page).locator('.chat-list')).toContainText('<img src=x');
  await expect(page.locator('.chat-list img, h1 img, main script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  await page.getByRole('link', { name: 'All nets' }).click(); // list view renders names as text too
  await expect(page.locator('.net-name').first()).toContainText('<img');
  await expect(page.locator('.nets img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('chat API refuses anonymous access', async ({ request }) => {
  expect((await request.get('/api/nets/0123456789/chat')).status()).toBe(401);
  const post = await request.post('/api/nets/0123456789/chat', { data: { text: 'hi' }, headers: { 'x-net-logger-plus': '1' } });
  expect(post.status()).toBe(401);
  const noHeader = await request.post('/api/nets/0123456789/chat', { data: { text: 'hi' } });
  expect(noHeader.status()).toBe(403); // CSRF header required
});

test('layout fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  await page.goto('/');
  expect(await noOverflow()).toBe(true);

  await signIn(page);
  await createNet(page, 'Phone Net With A Fairly Long Name Here');
  await startNet(page);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  await say(page, 'A long message '.repeat(20));
  await expect(chatBox(page).locator('.chat-list li').first()).toBeVisible();
  expect(await noOverflow()).toBe(true);
});

test('net control sees every command, with its description, above the command box', async ({ page, browser }) => {
  await signIn(page);
  const url = await createNet(page, 'Command Reference Net');
  await startNet(page);

  const served = (await (await page.request.get(`/api/nets/${url.split('/').pop()}`)).json()).commands;
  expect(served.length).toBeGreaterThanOrEqual(9);

  const list = page.locator('dl.cmd-ref');
  await expect(list.locator('dt')).toHaveCount(served.length);
  for (const c of served) {
    await expect(list.locator('dt', { hasText: c.usage }).first()).toBeVisible();
    await expect(list.getByText(c.help, { exact: true })).toBeVisible();
  }

  await expect(list.locator('dt', { hasText: '/ci CALL [CALL ...]' })).toBeVisible();
  await expect(list.getByText('Check in one or more stations for them (separate callsigns with spaces), for operators who are not using the app.', { exact: true })).toBeVisible();

  // it sits above the command box, not below it
  const listBox = await list.boundingBox();
  const inputBox = await page.getByLabel('Net control command').boundingBox();
  expect(listBox.y + listBox.height).toBeLessThan(inputBox.y);

  // people who are not net control see neither the list nor the box
  const watcher = await newPerson(browser);
  await signIn(watcher.page);
  await watcher.page.goto(url);
  await expect(watcher.page.getByRole('heading', { level: 1 })).toContainText('Command Reference Net');
  await expect(watcher.page.locator('dl.cmd-ref')).toBeHidden();
  await expect(watcher.page.getByLabel('Net control command')).toBeHidden();
  await watcher.context.close();
});

test('/ci: net control checks in an operator who is not using the app', async ({ page, browser }) => {
  const ncs = await signIn(page);
  const url = await createNet(page, 'Voice Check-in Net');
  await startNet(page);

  const watcher = await newPerson(browser);
  await watcher.page.goto(url);
  await expect(watcher.page.getByRole('heading', { level: 1 })).toContainText('Voice Check-in Net');

  await run(page, '/ci n0tst'); // lower case on purpose
  const mine = row(page, 'N0TST');
  await expect(mine).toContainText('In');
  await expect(mine).toContainText('Pat · Austin, TX, United States'); // QRZ details, though nobody signed in as N0TST
  await expect(page.locator('.log')).toContainText(`N0TST checked in by ${ncs}`);
  await expect(row(watcher.page, 'N0TST')).toContainText('In'); // a visitor sees it live

  await run(page, '/ci N0TST');
  await expect(page.locator('main > .msg')).toContainText(/already checked in/i);
  await run(page, '/ci NOTACALL');
  await expect(page.locator('main > .msg')).toContainText(/NOTACALL: not a valid callsign/i);
  await watcher.context.close();
});

test('an operator checked in by net control can take over their own station', async ({ page, browser }) => {
  await signIn(page);
  const url = await createNet(page, 'Takeover Net');
  await startNet(page);

  const bobP = await newPerson(browser);
  const bob = await signIn(bobP.page);
  await run(page, `/ci ${bob}`); // net control hears Bob on the air and checks him in
  await expect(row(page, bob)).toContainText('In');

  await bobP.page.goto(url);
  await expect(bobP.page.getByRole('button', { name: 'Check out' })).toBeVisible(); // he is already in
  await expect(bobP.page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0);

  await bobP.page.getByRole('button', { name: 'Raise hand' }).click();
  await expect(row(page, bob)).toContainText('Hand up'); // net control sees it live
  await bobP.page.getByRole('button', { name: 'Check out' }).click();
  await expect(row(page, bob)).toContainText('Out');
  expect(await page.locator('.ledger tbody tr').filter({ hasText: bob }).count()).toBe(1); // never duplicated
  await bobP.context.close();
});

/** Count how many live-update connections and shared workers a page creates. */
const countStreams = () => {
  window.__streams = [];
  window.__workers = [];
  const Native = window.EventSource;
  window.EventSource = function (...args) {
    window.__streams.push(String(args[0]));
    return new Native(...args);
  };
  window.EventSource.prototype = Native.prototype;
  const NativeSW = window.SharedWorker;
  if (NativeSW) {
    window.SharedWorker = function (...args) {
      window.__workers.push(String(args[0]));
      return new NativeSW(...args);
    };
    window.SharedWorker.prototype = NativeSW.prototype;
  }
};

test('a net page joins one shared live-update connection instead of opening its own', async ({ page }) => {
  // Browsers allow only six connections per site over plain HTTP/1.1, so a stream per tab stalls buttons.
  await page.addInitScript(countStreams);
  await signIn(page);
  await createNet(page, 'Shared Stream Net');
  await startNet(page);
  await expect(chatBox(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__workers)).toEqual(['/js/stream-worker.js']);
  expect(await page.evaluate(() => window.__streams)).toEqual([]); // the worker holds the connection, not the page
});

test('without SharedWorker a net page holds exactly one live-update connection of its own', async ({ page }) => {
  await page.addInitScript(() => { window.SharedWorker = undefined; });
  await page.addInitScript(countStreams);
  await signIn(page);
  await createNet(page, 'One Stream Net');
  await startNet(page);
  await expect(chatBox(page)).toBeVisible(); // signed in with a callsign: chat is on, and still only one stream
  const streams = await page.evaluate(() => window.__streams);
  expect(streams).toHaveLength(1);
  expect(streams[0]).toMatch(/\/api\/nets\/[a-f0-9]{10}\/events$/);
});

test('eight tabs of the same net all keep working over plain HTTP', async ({ page }) => {
  await signIn(page);
  const url = await createNet(page, 'Many Tabs Net');
  await startNet(page);

  const tabs = [page];
  for (let i = 0; i < 7; i++) {
    const tab = await page.context().newPage();
    track(tab);
    await tab.goto(url);
    await expect(tab.getByRole('heading', { level: 1 })).toContainText('Many Tabs Net');
    await expect(chatBox(tab)).toBeVisible();
    tabs.push(tab);
  }

  // The newest tab can still act (it would hang past six tabs if each held its own stream), and every other tab still receives the result live.
  await say(tabs[7], 'hello from the eighth tab');
  for (const tab of tabs) await expect(chatBox(tab).locator('.chat-list')).toContainText('hello from the eighth tab');
  await run(tabs[7], '/note eight tabs open');
  for (const tab of tabs) await expect(tab.locator('.log')).toContainText('Note: eight tabs open');
});

test('/ci with several callsigns adds every one, in order, each with its QRZ details', async ({ page, browser }) => {
  const ncs = await signIn(page);
  const url = await createNet(page, 'Group Check-in Net');
  await startNet(page);
  const watcher = await newPerson(browser);
  await watcher.page.goto(url);
  await expect(watcher.page.getByRole('heading', { level: 1 })).toContainText('Group Check-in Net');

  await run(page, '/ci n0tst w5ham kb6lmn'); // three callsigns, separated by spaces
  for (const call of ['N0TST', 'W5HAM', 'KB6LMN']) {
    await expect(row(page, call)).toContainText('In');
    await expect(row(page, call)).toContainText('Pat · Austin, TX, United States'); // QRZ details for each one
    await expect(row(watcher.page, call)).toContainText('In'); // and a visitor sees them live
  }
  await expect(page.locator('.ledger tbody tr .n')).toHaveText(['1', '2', '3']);
  const order = await page.locator('.ledger tbody tr .call').evaluateAll((els) => els.map((e) => e.firstChild.textContent));
  expect(order).toEqual(['N0TST', 'W5HAM', 'KB6LMN']); // the order they were typed
  await expect(page.locator('.log li', { hasText: 'checked in by' })).toHaveCount(1); // one log line, not three
  await expect(page.locator('.log')).toContainText(`N0TST, W5HAM, KB6LMN checked in by ${ncs}`);
  await expect(page.getByLabel('Net control command')).toHaveValue('');

  // A mix: the good one is added; what was skipped is explained, and it is not shown as an error.
  await run(page, '/ci ae7zzz notacall n0tst');
  const note = page.locator('main > .msg');
  await expect(note).toContainText('Checked in 1. Skipped: NOTACALL (not a valid callsign), N0TST (already checked in).');
  await expect(note).not.toHaveClass(/error/);
  await expect(row(page, 'AE7ZZZ')).toContainText('In');
  await expect(row(page, 'AE7ZZZ').locator('.op')).toHaveCount(0); // QRZ has no record of it: checked in, just no details
  await watcher.context.close();
});

test('QRZ details: nothing is drawn when QRZ has nothing to show, and partial details still are', async ({ page }) => {
  await signIn(page);
  await createNet(page, 'Free Account Net');
  await startNet(page);
  await run(page, '/ci k1empt k1loco n0tst');
  for (const call of ['K1EMPT', 'K1LOCO', 'N0TST']) await expect(row(page, call)).toContainText('In');
  await expect(row(page, 'N0TST').locator('.op')).toHaveText('Pat · Austin, TX, United States');
  await expect(row(page, 'K1LOCO').locator('.op')).toHaveText('Canada'); // partial data is shown
  await expect(row(page, 'K1EMPT').locator('.op')).toHaveCount(0); // no blank line under the callsign
});

test('even stored empty details never draw a blank line (old data, or any other source)', async ({ page }) => {
  await page.addInitScript(() => { window.SharedWorker = undefined; }); // the test feeds the page its own stream, so use a stream of the page's own
  await signIn(page);
  const url = await createNet(page, 'Old Data Net');
  const id = url.split('/').pop();
  const real = (await (await page.request.get(`/api/nets/${id}`)).json()).net;
  const net = { ...real, status: 'live', stations: [{ callsign: 'N0TST', state: 'in', hand: false, handAt: null, rst: null, info: { name: '', location: '' }, joinedAt: 1, seq: 1 }] };
  await page.route(`**/api/nets/${id}/events`, (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }, body: `retry: 600000\nevent: net\ndata: ${JSON.stringify(net)}\n\n` }));
  await page.reload();
  await expect(row(page, 'N0TST')).toContainText('In');
  await expect(row(page, 'N0TST').locator('.op')).toHaveCount(0);
});

/** A callsign the QRZ stand-in has no record of (it treats anything ending in ZZZ as unknown). Unique per run. */
const unknownToQrz = () => {
  const pick = () => LETTERS[Math.floor(Math.random() * 26)];
  return `${pick()}${pick()}9ZZZ`;
};

test('registration asks for a callsign, a name and a location, and all three are required', async ({ page }) => {
  const call = nextCall();
  const link = await requestLink(page, nextEmail('reg'));
  await link.click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Set your callsign, name and location' });
  const save = page.getByRole('button', { name: 'Save callsign, name and location' });
  await expect(heading).toBeVisible();
  await expect(page.getByLabel('Callsign')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('required', '');
  await expect(page.getByLabel('Location')).toHaveAttribute('required', '');
  await expect(page.getByText('not a street address')).toBeVisible(); // the privacy hint

  // empty required fields stop the browser from submitting: still registering
  await page.getByLabel('Callsign').fill(call);
  await save.click();
  await expect(heading).toBeVisible();
  await expect(page.locator('.bar .who')).toContainText('@');

  // something that is not a name is refused by the server, with a clear message
  await page.getByLabel('Name', { exact: true }).fill('12');
  await page.getByLabel('Location').fill('Albany, NY');
  await save.click();
  await expect(page.locator('.msg.error')).toContainText(/Enter your name/);
  await expect(heading).toBeVisible();

  // and so is something that is not a location
  await page.getByLabel('Name', { exact: true }).fill('Hiram');
  await page.getByLabel('Location').fill('12345');
  await save.click();
  await expect(page.locator('.msg.error')).toContainText(/Enter your location/);
  await expect(heading).toBeVisible();

  await page.getByLabel('Location').fill('Albany, NY');
  await save.click();
  await expect(page.locator('.bar .who')).toHaveText(call);
  await expect(heading).toHaveCount(0);
  await expect(page.getByText('Create a net')).toBeVisible(); // registration complete: the rest of the app opens up

  // the profile was saved: it is pre-filled in "Your profile" and survives a reload
  await page.reload();
  await page.getByText('Your profile').click();
  await expect(page.getByLabel('Callsign')).toHaveValue(call);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Hiram');
  await expect(page.getByLabel('Location')).toHaveValue('Albany, NY');
});

test('the name an operator typed is what the ledger shows, not QRZ\'s', async ({ page }) => {
  const call = await signIn(page, undefined, undefined, 'Albany, NY', 'Hiram'); // QRZ would say "Pat"
  await createNet(page, 'Typed Name Net');
  await startNet(page);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(row(page, call).locator('.op')).toHaveText('Hiram · Albany, NY');
});

test('the ledger shows the location people typed, even when QRZ knows nothing about them', async ({ page, browser }) => {
  const nobody = unknownToQrz(); // QRZ has no record of this callsign
  await signIn(page, nobody, undefined, 'Boise, ID');
  const url = await createNet(page, 'No QRZ Needed Net');
  await startNet(page);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(row(page, nobody)).toContainText('In');
  await expect(row(page, nobody).locator('.op')).toHaveText('Boise, ID'); // callsign + location, no subscription involved

  // someone QRZ does know: the name comes from QRZ, the location is still what they typed
  const bobP = await newPerson(browser);
  const bob = await signIn(bobP.page, undefined, undefined, 'Ottawa, Canada');
  await bobP.page.goto(url);
  await bobP.page.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(row(page, bob).locator('.op')).toHaveText('Pat · Ottawa, Canada');
  await expect(row(page, nobody).locator('.op')).toHaveText('Boise, ID');

  // a visitor sees both lines, and never an email address
  const visitor = await newPerson(browser);
  await visitor.page.goto(url);
  await expect(row(visitor.page, nobody).locator('.op')).toHaveText('Boise, ID');
  await expect(row(visitor.page, bob).locator('.op')).toHaveText('Pat · Ottawa, Canada');
  await expect(visitor.page.locator('body')).not.toContainText('@example.org');
  await bobP.context.close();
  await visitor.context.close();
});

test('a typo in the location can be fixed later, and a running net shows the change live', async ({ page, browser }) => {
  const call = await signIn(page, undefined, undefined, 'Albny, NY'); // typo
  const url = await createNet(page, 'Typo Net');
  await startNet(page);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  const watcher = await newPerson(browser);
  await watcher.page.goto(url);
  await expect(row(watcher.page, call).locator('.op')).toContainText('Albny, NY');

  await page.getByRole('link', { name: 'All nets' }).click();
  await page.getByText('Your profile').click();
  await expect(page.getByLabel('Location')).toHaveValue('Albny, NY'); // the form is pre-filled
  await page.getByLabel('Location').fill('Albany, NY');
  await page.getByRole('button', { name: 'Update profile' }).click();
  await expect(page.locator('.bar .who')).toHaveText(call);

  await expect(row(watcher.page, call).locator('.op')).toContainText('Albany, NY'); // pushed live, no reload
  await expect(row(watcher.page, call).locator('.op')).not.toContainText('Albny');
  await watcher.context.close();
});

test('loggers: net control names them, they get a label and a /ci-only box, and it all ends cleanly', async ({ page, browser }) => {
  const ncs = await signIn(page);
  const url = await createNet(page, 'Logger Net');
  await startNet(page);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();

  const bobP = await newPerson(browser);
  const bob = await signIn(bobP.page);
  const carolP = await newPerson(browser);
  const carol = await signIn(carolP.page);
  for (const p of [bobP, carolP]) {
    await p.page.goto(url);
    await p.page.getByRole('button', { name: 'Check in', exact: true }).click();
  }
  await expect(row(page, bob)).toContainText('In');
  await expect(row(page, carol)).toContainText('In');

  // an ordinary checked-in station gets no command box at all
  await expect(bobP.page.getByLabel('Logger command')).toBeHidden();
  await expect(bobP.page.getByLabel('Net control command')).toBeHidden();

  // net control names both loggers (and is told about the one entry that cannot be used)
  await run(page, `/logger ${bob} ${carol} NOTACALL`);
  await expect(page.locator('main > .msg')).toContainText('Made 2 loggers. Skipped: NOTACALL (not a valid callsign).');
  for (const c of [bob, carol]) await expect(row(page, c).locator('.tag.logger')).toHaveText('LOGGER');
  await expect(row(page, ncs).locator('.tag')).toHaveText('NCS'); // net control keeps its own label
  await expect(page.locator('.log')).toContainText(`${bob}, ${carol} are now loggers`);

  // the logger's page changes live: a Logger commands box with only /ci, and no net control buttons
  const lp = bobP.page;
  await expect(lp.getByRole('heading', { name: 'Logger commands' })).toBeVisible();
  await expect(lp.locator('dl.cmd-ref dt')).toHaveText(['/ci CALL [CALL ...]', '/co CALL [CALL ...]']);
  await expect(lp.getByText('Net control has made you a logger')).toBeVisible();
  await expect(lp.getByRole('button', { name: 'Close net' })).toHaveCount(0);
  await expect(row(lp, carol).locator('.tag.logger')).toHaveText('LOGGER'); // everyone sees who the loggers are

  // the logger adds callsigns: they join the ledger for everyone, with QRZ details, and the log names the logger
  await lp.getByLabel('Logger command').fill('/ci n0tst w5ham');
  await lp.getByRole('button', { name: 'Run', exact: true }).click();
  for (const c of ['N0TST', 'W5HAM']) {
    await expect(row(page, c)).toContainText('In');
    await expect(row(page, c).locator('.op')).toHaveText('Pat · Austin, TX, United States');
    await expect(row(lp, c)).toContainText('In');
  }
  await expect(page.locator('.log')).toContainText(`N0TST, W5HAM checked in by ${bob} (logger)`);

  // a logger can also check stations out, for example to fix a callsign added by mistake
  await lp.getByLabel('Logger command').fill('/co w5ham');
  await lp.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(row(page, 'W5HAM')).toContainText('Out');
  await expect(row(page, 'W5HAM')).toHaveClass(/\bout\b/);
  await expect(page.locator('.log')).toContainText(`W5HAM checked out by ${bob} (logger)`);

  // ...but not net control, and not another logger
  await lp.getByLabel('Logger command').fill(`/co ${ncs}`);
  await lp.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(lp.locator('main > .msg')).toContainText(`${ncs}: is net control.`);
  await expect(lp.locator('main > .msg')).toHaveClass(/error/);
  await lp.getByLabel('Logger command').fill(`/co ${carol}`);
  await lp.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(lp.locator('main > .msg')).toContainText('is a logger, so only net control can check them out');
  await expect(row(page, ncs)).toContainText('In');
  await expect(row(page, carol)).toContainText('In');
  await expect(row(page, carol).locator('.tag.logger')).toHaveText('LOGGER'); // still a logger

  // anything else is refused, and the net is untouched
  await lp.getByLabel('Logger command').fill('/close');
  await lp.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(lp.locator('main > .msg')).toContainText('Loggers can only use /ci and /co.');
  await expect(lp.locator('h1 .lamp.live')).toBeVisible();

  // taking the role away removes the label and the box, live; the other logger is unaffected
  await run(page, `/rlogger ${bob}`);
  await expect(row(page, bob).locator('.tag.logger')).toHaveCount(0);
  await expect(row(page, carol).locator('.tag.logger')).toHaveText('LOGGER');
  await expect(lp.getByLabel('Logger command')).toBeHidden();
  await expect(lp.getByRole('heading', { name: 'Logger commands' })).toBeHidden();
  await expect(carolP.page.getByLabel('Logger command')).toBeVisible();

  // a logger who checks out loses the role
  await carolP.page.getByRole('button', { name: 'Check out' }).click();
  await expect(row(page, carol)).toContainText('Out');
  await expect(row(page, carol).locator('.tag.logger')).toHaveCount(0);
  await expect(carolP.page.getByLabel('Logger command')).toBeHidden();
  await bobP.context.close();
  await carolP.context.close();
});

test('/co checks stations out: they stay on the ledger as Out, and /ci can bring them back', async ({ page, browser }) => {
  const ncs = await signIn(page);
  const url = await createNet(page, 'Check-out Net');
  await startNet(page);

  const bobP = await newPerson(browser);
  const bob = await signIn(bobP.page);
  await bobP.page.goto(url);
  await bobP.page.getByRole('button', { name: 'Check in', exact: true }).click();
  await bobP.page.getByRole('button', { name: 'Raise hand' }).click();
  await run(page, '/ci n0tst w5ham kb6lmn');
  for (const c of ['N0TST', 'W5HAM', 'KB6LMN']) await expect(row(page, c)).toContainText('In');
  await expect(row(page, bob)).toContainText('Hand up');

  // net control checks out two stations nobody signed in as, and Bob (who has an account and a raised hand)
  await run(page, `/co n0tst kb6lmn ${bob}`);
  for (const c of ['N0TST', 'KB6LMN', bob]) {
    await expect(row(page, c)).toContainText('Out');
    await expect(row(page, c)).toHaveClass(/\bout\b/); // struck through, but still on the ledger
  }
  await expect(row(page, bob)).not.toContainText('Hand up'); // checking out lowers the hand
  await expect(row(page, 'W5HAM')).toContainText('In'); // the one not named is untouched
  await expect(page.locator('.log li', { hasText: 'checked out by' })).toHaveCount(1); // one log line for the group
  await expect(page.locator('.log')).toContainText(`N0TST, KB6LMN, ${bob} checked out by ${ncs}`);

  // Bob's own screen changes live: he is out, with the option to check back in
  await expect(bobP.page.getByRole('button', { name: 'Check in', exact: true })).toBeVisible();
  await expect(bobP.page.getByRole('button', { name: 'Raise hand' })).toHaveCount(0);

  // nothing usable is an error; a mix succeeds with a plain notice
  await run(page, '/co n0tst w9xyz');
  await expect(page.locator('main > .msg')).toContainText('Nobody was checked out. N0TST (already checked out), W9XYZ (not on the list).');
  await expect(page.locator('main > .msg')).toHaveClass(/error/);
  await run(page, '/co w5ham w9xyz');
  await expect(page.locator('main > .msg')).toContainText('Checked out 1. Skipped: W9XYZ (not on the list).');
  await expect(page.locator('main > .msg')).not.toHaveClass(/error/);
  await expect(row(page, 'W5HAM')).toContainText('Out');

  // /ci brings a checked-out station straight back, as the same entry, and Bob can use the button
  await run(page, '/ci n0tst');
  await expect(row(page, 'N0TST')).toContainText('In');
  await expect(page.locator('.ledger tbody tr').filter({ hasText: 'N0TST' })).toHaveCount(1);
  await bobP.page.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(row(page, bob)).toContainText('In');
  await bobP.context.close();
});

test('a net page shows only the ledger, the commands, live chat and the activity log', async ({ page, browser }) => {
  await signIn(page);
  const url = await createNet(page, 'Tidy Net');
  await startNet(page);
  const headings = (p) => p.locator('main h2:visible').allTextContents();
  const forms = (p) => p.locator('main form:visible').count();
  const top = async (loc) => (await loc.boundingBox()).y;

  // net control: ledger, then commands, then chat, then the activity log, and nothing else
  expect(await headings(page)).toEqual(['Net control commands', 'Net chat', 'Activity']);
  expect(await forms(page)).toBe(2); // the command box and the chat box: no lookup form
  await expect(page.getByLabel('Look up a callsign')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Look up' })).toHaveCount(0);
  const order = [page.locator('table.ledger'), page.locator('form.cmd'), page.locator('section.chat'), page.locator('ol.log')];
  const ys = [];
  for (const loc of order) ys.push(await top(loc));
  expect(ys).toEqual([...ys].sort((a, b) => a - b)); // top to bottom, in that order

  // an ordinary signed-in operator: ledger, chat, activity
  const bobP = await newPerson(browser);
  await signIn(bobP.page);
  await bobP.page.goto(url);
  await expect(bobP.page.locator('section.chat')).toBeVisible();
  expect(await headings(bobP.page)).toEqual(['Net chat', 'Activity']);
  expect(await forms(bobP.page)).toBe(1); // just the chat box

  // a visitor who is not signed in: the ledger and the activity log
  const visitor = await newPerson(browser);
  await visitor.page.goto(url);
  await expect(visitor.page.getByRole('table')).toBeVisible();
  expect(await headings(visitor.page)).toEqual(['Activity']);
  expect(await forms(visitor.page)).toBe(0);
  await bobP.context.close();
  await visitor.context.close();
});

test('QRZ details still arrive at check-in, with no lookup box needed', async ({ page }) => {
  await signIn(page, undefined, undefined, 'Albany, NY');
  await createNet(page, 'Backup Lookup Net');
  await startNet(page);
  await run(page, '/ci n0tst');
  await expect(row(page, 'N0TST').locator('.op')).toHaveText('Pat · Austin, TX, United States'); // looked up automatically
  await expect(page.locator('body')).not.toContainText('Look up');
});
