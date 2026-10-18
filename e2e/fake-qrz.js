// Tiny stand-in for the QRZ XML service so browser tests are deterministic and offline.
// Any callsign resolves to "Pat Operator, Austin, TX", except ones ending in ZZZ (not found).
import http from 'node:http';

const NS = 'xmlns="http://xmldata.qrz.com"';
const port = Number(process.env.FAKE_QRZ_PORT || 3201);

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return res.end('ok');
    // QRZ separates parameters with ';' (the app follows the spec), so parse by hand.
    const q = Object.fromEntries(url.search.slice(1).split(/[;&]/).filter(Boolean).map((p) => p.split('=').map(decodeURIComponent)));
    res.setHeader('content-type', 'text/xml');
    if (q.username) {
      if (q.password !== 'e2e') return res.end(`<QRZDatabase ${NS}><Session><Error>Username/password incorrect</Error></Session></QRZDatabase>`);
      return res.end(`<QRZDatabase ${NS}><Session><Key>e2e-key</Key></Session></QRZDatabase>`);
    }
    if (q.s !== 'e2e-key') return res.end(`<QRZDatabase ${NS}><Session><Error>Session Timeout</Error></Session></QRZDatabase>`);
    const call = (q.callsign || '').toUpperCase();
    if (call.endsWith('EMPT')) { // known to QRZ, nothing to show (like a free account)
      return res.end(`<QRZDatabase ${NS}><Callsign><call>${call}</call></Callsign><Session><Error>A subscription is required to obtain the complete data</Error><Key>e2e-key</Key></Session></QRZDatabase>`);
    }
    if (call.endsWith('LOCO')) { // partial: country only
      return res.end(`<QRZDatabase ${NS}><Callsign><call>${call}</call><country>Canada</country></Callsign><Session><Key>e2e-key</Key></Session></QRZDatabase>`);
    }
    if (call.endsWith('ZZZ')) {
      return res.end(`<QRZDatabase ${NS}><Session><Error>Not found: ${call}</Error><Key>e2e-key</Key></Session></QRZDatabase>`);
    }
    res.end(`<QRZDatabase ${NS}><Callsign><call>${call}</call><fname>Pat</fname><name>Operator</name>
<addr1>1 Secret Street</addr1><addr2>Austin</addr2><state>TX</state><country>United States</country>
<grid>EM10</grid><class>E</class><email>private@example.org</email></Callsign><Session><Key>e2e-key</Key></Session></QRZDatabase>`);
  })
  .listen(port, '127.0.0.1');
