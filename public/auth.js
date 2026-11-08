// Sign-in / 2FA / sign-up page.
const $ = (s) => document.querySelector(s);
const show = (id) => { ['#f-login', '#f-2fa', '#f-verify', '#f-signup', '#closed'].forEach((x) => { $(x).hidden = x !== id; }); $(id)?.querySelector('input')?.focus(); };
const err = (msg) => { const e = $('#auth-err'); e.textContent = msg || ''; e.hidden = !msg; };
async function call(path, body) {
  const r = await fetch(`/api/auth${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const busy = (form, on) => { const b = form.querySelector('button'); b.disabled = on; b.dataset.label ||= b.textContent; b.textContent = on ? 'Please wait…' : b.dataset.label; };
// Back to the page you asked for (the #/route survives the redirect to /login).
const goIn = (path = `/${location.hash || ''}`) => { location.href = path; };
let ticket = null;

$('#theme-toggle').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('pl-theme', next); } catch { /* ignore */ }
};

$('#f-login').onsubmit = async (e) => {
  e.preventDefault(); err(''); busy(e.target, true);
  try {
    const r = await call('/login', { email: $('#li-email').value, password: $('#li-pass').value });
    if (r.mfa) { ticket = r.ticket; show('#f-2fa'); } else goIn();
  } catch (x) { err(x.message); } finally { busy(e.target, false); }
};
$('#f-2fa').onsubmit = async (e) => {
  e.preventDefault(); err(''); busy(e.target, true);
  try { await call('/login/2fa', { ticket, code: $('#tf-code').value.replace(/\s/g, '') }); goIn(); } catch (x) { err(x.message); } finally { busy(e.target, false); }
};
$('#f-signup').onsubmit = async (e) => {
  e.preventDefault(); err(''); busy(e.target, true);
  try {
    const r = await call('/signup', { name: $('#su-name').value, email: $('#su-email').value, password: $('#su-pass').value });
    if (r.verify) {
      ticket = r.ticket;
      $('#verify-sub').innerHTML = r.viaEmail
        ? `<strong>${r.sentTo}</strong> owns existing data on this server. To open it, enter the 6-digit code we just emailed to that address.`
        : `<strong>${r.sentTo}</strong> owns existing data on this server. Its mailbox is not set up here, so the 6-digit code is printed in the server log.`;
      show('#f-verify');
    } else goIn('/#/settings?tab=security&welcome=1');
  } catch (x) { err(x.message); } finally { busy(e.target, false); }
};
$('#f-verify').onsubmit = async (e) => {
  e.preventDefault(); err(''); busy(e.target, true);
  try { await call('/signup/verify', { ticket, code: $('#vf-code').value.trim() }); goIn('/#/settings?tab=security&welcome=1'); } catch (x) { err(x.message); } finally { busy(e.target, false); }
};
$('#su-pass').oninput = (e) => {
  const v = e.target.value; let s = 0;
  if (v.length >= 10) s++; if (v.length >= 14) s++; if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++; if (/\d/.test(v)) s++; if (/[^a-z0-9]/i.test(v)) s++;
  const bar = $('#pw-bar'); bar.style.width = `${(s / 5) * 100}%`;
  bar.style.background = s <= 2 ? 'var(--bad)' : s === 3 ? 'var(--warn)' : 'var(--ok)';
  $('#pw-hint').textContent = s <= 2 ? 'Weak — add length, a number and a symbol.' : s === 3 ? 'Okay — a bit longer would be better.' : 'Strong password.';
};

(async () => {
  const st = await call('/status').catch(() => ({ enabled: true }));
  if (st.user || st.enabled === false) return goIn();
  const wantsSignup = location.pathname === '/signup' || st.needsSetup;
  if (st.needsSetup) {
    $('#su-title').textContent = 'Set up your workspace';
    $('#su-sub').textContent = 'Create your account. If this server already has your data, sign up with that email to open it.';
  }
  if (!st.signupsOpen) $('#to-signup').hidden = true;
  if (wantsSignup) show(st.signupsOpen ? '#f-signup' : '#closed'); else show('#f-login');
})();
