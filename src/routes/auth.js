// Sign-up, sign-in (with optional 2FA), sign-out and account security.
import express from 'express';
import * as auth from '../services/auth.js';

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
authRouter.post('/signup', h(async (req, res) => {
  const r = await auth.signup(req.body || {});
  return r.verify ? { verify: true, ticket: r.ticket, sentTo: r.sentTo, viaEmail: r.viaEmail } : startSession(res, req, r.user);
}));
authRouter.post('/signup/verify', h((req, res) => startSession(res, req, auth.verifySignup(req.body || {}).user)));
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
authRouter.get('/me', h((req) => auth.accountInfo(me(req).id)));
authRouter.post('/2fa/start', h((req) => auth.startTwoFactor(me(req).id)));
authRouter.post('/2fa/enable', h((req) => auth.enableTwoFactor(me(req).id, req.body?.code)));
authRouter.post('/2fa/disable', h((req) => auth.disableTwoFactor(me(req).id, req.body || {})));
authRouter.post('/password', h((req) => auth.changePassword(me(req).id, req.body || {})));
