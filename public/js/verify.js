import { api } from './api.js';

const token = location.hash.slice(1);
const msg = document.getElementById('msg');
const btn = document.getElementById('go');
history.replaceState(null, '', location.pathname); // keep the token out of history

// The button starts disabled in the HTML so it cannot be pressed before this script is ready.
if (token) btn.disabled = false;
else msg.textContent = 'This page needs the full link from your email.';

btn.addEventListener('click', async () => {
  btn.disabled = true;
  msg.textContent = 'Signing in…';
  try {
    await api('POST', '/api/auth/verify', { token });
    location.replace('/');
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg error';
  }
});
