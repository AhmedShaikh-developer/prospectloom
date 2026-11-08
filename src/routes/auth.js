// Sign-up, sign-in (with optional 2FA), sign-out and account security.
import express from 'express';
import * as auth from '../services/auth.js';
import { saveSettings } from '../lib/settings.js';

export const authRouter = express.Router();
const h = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};
const startSession = (res, req, user) => { res.setHeader('Set-Cookie', auth.cookieHeader(auth.createSession(user.id, req), req)); return { user }; };
const me = (req) => {
  const user = auth.sessionUser(auth.readCookie(req));
  if (!user) throw Object.assign(new Error('Sign in required'), { status: 401 });
  return user;
};

authRouter.get('/status', h((req) => ({
  enabled: auth.isEnabled(), user: auth.sessionUser(auth.readCookie(req)),
  needsSetup: auth.userCount() === 0, signupsOpen: auth.signupsOpen(),
})));
authRouter.post('/signup', h((req, res) => startSession(res, req, auth.signup(req.body || {}))));
authRouter.post('/login', h((req, res) => {
  const r = auth.login(req.body || {}, req.ip);
  return r.mfa ? r : startSession(res, req, r.user);
}));
authRouter.post('/login/2fa', h((req, res) => startSession(res, req, auth.loginSecondFactor(req.body || {}, req.ip).user)));
authRouter.post('/logout', h((req, res) => {
  auth.endSession(auth.readCookie(req));
  res.setHeader('Set-Cookie', auth.cookieHeader('', req));
  return { ok: true };
}));

// Signed-in only
authRouter.get('/me', h((req) => ({ user: me(req), users: auth.listUsers() })));
authRouter.post('/2fa/start', h((req) => auth.startTwoFactor(me(req).id)));
authRouter.post('/2fa/enable', h((req) => auth.enableTwoFactor(me(req).id, req.body?.code)));
authRouter.post('/2fa/disable', h((req) => auth.disableTwoFactor(me(req).id, req.body || {})));
authRouter.post('/password', h((req) => auth.changePassword(me(req).id, req.body || {})));
authRouter.delete('/users/:id', h((req) => auth.removeUser(me(req).id, Number(req.params.id))));
authRouter.put('/signups', h((req) => {
  if (me(req).role !== 'owner') throw new Error('Only the owner can open or close sign-ups');
  saveSettings({ allow_signups: req.body?.open ? '1' : '0' });
  return { signupsOpen: auth.signupsOpen() };
}));
