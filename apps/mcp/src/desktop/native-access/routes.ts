import express from 'express';
import type { Express } from 'express';
import { DesktopNativeAccess } from './access';
import { invokeDesktop } from './invoke';
import { DESKTOP_OPERATIONS, desktopOperationTimeout } from '../engine-bridge';
import { enrollMacAccount } from '../../../../bridge/src/account-recovery/enroll';
import { websiteOrigin } from '../../oauth/consent/website-session';

export function installDesktopNativeRoutes(app: Express, socketPath: string, origin: string,
  access = new DesktopNativeAccess()): void {
  app.use('/desktop', (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" });
    next();
  });
  app.get('/desktop/authorize', (req, res) => {
    try {
      const row = access.begin(String(req.query.challenge ?? ''), String(req.query.state ?? ''));
      res.cookie('granttap_desktop_consent', row.confirmation, {
        httpOnly: true, sameSite: 'strict', path: '/desktop/approve', maxAge: 300_000,
      });
      res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>GrantTap for Mac</title>
<h1>Allow GrantTap for Mac on this computer</h1><p>The app can inspect tasks, send your messages, handle approvals and configure your local relay. This does not authorize another computer or a coding provider.</p>
<form action="/desktop/approve" method="post"><input type="hidden" name="id" value="${row.id}"><input type="hidden" name="confirmation" value="${row.confirmation}"><input type="hidden" name="state" value="${row.state}"><button type="submit">Allow this Mac app</button></form></html>`);
    } catch { res.status(400).json({ error: 'Invalid native authorization' }); }
  });
  app.post('/desktop/approve', (req, res) => {
    const confirmation = String(req.body?.confirmation ?? '');
    if (req.headers.origin !== origin || !confirmation ||
      !(req.headers.cookie ?? '').split(';').some(cookie => cookie.trim() === `granttap_desktop_consent=${confirmation}`)) {
      res.status(403).json({ error: 'Native approval requires this local consent page' }); return;
    }
    try {
      const code = access.approve(String(req.body.id ?? ''), confirmation);
      const callback = new URL('granttap://desktop-auth');
      callback.search = new URLSearchParams({ code, state: String(req.body.state ?? '') }).toString();
      res.redirect(302, callback.href);
    } catch { res.status(400).json({ error: 'Native authorization expired' }); }
  });
  app.post('/desktop/token', express.json({ limit: '2kb' }), (req, res) => {
    try { res.json({ access_token: access.exchange(String(req.body?.code ?? ''), String(req.body?.verifier ?? '')) }); }
    catch { res.status(401).json({ error: 'Native code could not be verified' }); }
  });
  app.post('/desktop/account/link', express.json({ limit: '2kb' }), async (req, res) => {
    const nativeToken = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!access.verify(nativeToken)) {
      res.status(401).json({ error: 'Authorize GrantTap for Mac first' }); return;
    }
    try {
      res.json(await enrollMacAccount(String(req.body?.accountToken ?? ''),
        websiteOrigin() ?? 'https://granttap.com'));
    } catch {
      res.status(403).json({ error: 'Account link could not be verified' });
    }
  });
  app.post('/desktop/invoke', (req, res, next) => {
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ') || !access.verify(auth.slice(7))) {
      res.status(401).json({ error: 'Authorize GrantTap for Mac first' }); return;
    }
    next();
  }, express.json({ limit: '512kb' }), async (req, res) => {
    const operation = req.body?.operation;
    const input = req.body?.input;
    if (!DESKTOP_OPERATIONS.has(operation) || (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)))) {
      res.status(400).json({ error: 'Invalid desktop operation' }); return;
    }
    try { res.json(await invokeDesktop(socketPath, operation, input, desktopOperationTimeout(operation, input))); }
    catch { res.status(503).json({ error: 'Local desktop operation unavailable' }); }
  });
}
