/** Send a picture as the raw request body (not JSON). */
export async function apiUpload(url, blob) {
  const res = await fetch(url, { method: 'POST', headers: { 'x-net-logger-plus': '1', 'content-type': blob.type }, body: blob, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function api(method, url, body) {
  const opts = { method, headers: { 'x-net-logger-plus': '1' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
