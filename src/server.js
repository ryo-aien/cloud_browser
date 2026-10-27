import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { chromium } from 'playwright';
import { validateDestination } from './security.js';

const PORT = Number(process.env.PORT || 8080);
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'example.com')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || 2));
const FRAME_INTERVAL_MS = Math.max(200, Number(process.env.FRAME_INTERVAL_MS || 350));
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE_NAME = 'remote_browser_session';

// Keep listening even when misconfigured so Cloud Run's startup probe passes;
// every request except /healthz then returns 503 until the secrets are set.
const CONFIG_ERROR = (!APP_PASSWORD || APP_PASSWORD.length < 12 || !SESSION_SECRET || SESSION_SECRET.length < 32)
  ? 'APP_PASSWORD(12文字以上) と SESSION_SECRET(32文字以上) を設定してください'
  : null;
if (CONFIG_ERROR) console.error(CONFIG_ERROR);

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function issueToken() {
  const payload = String(Date.now() + SESSION_TTL_MS) + '.' + crypto.randomBytes(16).toString('hex');
  return payload + '.' + sign(payload);
}
function getCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const pos = part.indexOf('=');
    return pos === -1 ? ['', ''] : [part.slice(0, pos).trim(), part.slice(pos + 1).trim()];
  }));
}
function isAuthenticated(req) {
  const token = getCookies(req)[COOKIE_NAME];
  if (!token || token.length > 300) return false;
  const pieces = token.split('.');
  if (pieces.length !== 3) return false;
  const payload = pieces[0] + '.' + pieces[1];
  const expected = sign(payload);
  const a = Buffer.from(pieces[2]);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) &&
    Number(pieces[0]) > Date.now() && Number(pieces[0]) < Date.now() + SESSION_TTL_MS + 60_000;
}
function validPassword(password) {
  if (typeof password !== 'string') return false;
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.redirect('/login');
}
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.use((_req, res, next) => {
  if (!CONFIG_ERROR) return next();
  return res.status(503).type('text/plain; charset=utf-8').send('設定エラー: ' + CONFIG_ERROR);
});
app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  return res.sendFile(path.join(ROOT, 'public', 'login.html'));
});
app.get('/style.css', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'style.css')));
app.get('/login.js', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'login.js')));
let failedAttempts = 0;
let retryAt = 0;
app.post('/api/login', (req, res) => {
  if (Date.now() < retryAt) return res.status(429).json({ error: 'しばらくしてから再試行してください' });
  if (!validPassword(req.body?.password)) {
    failedAttempts += 1;
    if (failedAttempts >= 20) {
      retryAt = Date.now() + 5 * 60_000;
      failedAttempts = 0;
    }
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  failedAttempts = 0;
  res.cookie(COOKIE_NAME, issueToken(), {
    httpOnly: true,
    secure: req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  return res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true, secure: req.headers['x-forwarded-proto'] === 'https', sameSite: 'strict', path: '/',
  });
  res.status(204).end();
});
app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'app.html')));
app.get('/app.js', requireAuth, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'app.js')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
let activeSessions = 0;
let browserPromise;
function browserInstance() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
      .catch((err) => { browserPromise = null; throw err; });
  }
  return browserPromise;
}
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2_000_000) {
    ws.send(JSON.stringify(payload));
  }
}

server.on('upgrade', (req, socket, head) => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto === 'https' ? 'https' : 'http';
  const expectedOrigin = proto + '://' + req.headers.host;
  const reason = CONFIG_ERROR ? 'config' : req.url !== '/ws' ? 'path' : !isAuthenticated(req) ? 'auth'
    : req.headers.origin !== expectedOrigin ? 'origin ' + req.headers.origin + ' != ' + expectedOrigin : null;
  if (reason) {
    console.warn('WebSocket upgrade rejected:', reason);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', async (ws) => {
  if (activeSessions >= MAX_SESSIONS) {
    ws.close(1013, 'Server capacity reached');
    return;
  }
  activeSessions += 1;
  let context;
  let page;
  let alive = true;
  let busy = false;
  const stopped = new Promise((resolve) => ws.once('close', resolve));
  ws.on('close', () => { alive = false; });
  try {
    const browser = await browserInstance();
    if (!alive) return;
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'ja-JP',
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      const req = route.request();
      try {
        const topLevel = req.isNavigationRequest() && req.frame() === page?.mainFrame();
        await validateDestination(req.url(), ALLOWED_HOSTS, topLevel);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    page = await context.newPage();
    context.on('page', (opened) => {
      if (opened !== page) opened.close().catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) send(ws, { type: 'location', url: page.url() });
    });
    send(ws, { type: 'ready', viewport: { width: 1280, height: 800 }, url: page.url() });

    ws.on('message', async (buf) => {
      if (!alive || !page || busy) return;
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      try {
        if (msg.type === 'navigate') {
          busy = true;
          const url = await validateDestination(msg.url, ALLOWED_HOSTS, true);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        } else if (msg.type === 'back') {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        } else if (msg.type === 'forward') {
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        } else if (msg.type === 'reload') {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        } else if (msg.type === 'click' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
          await page.mouse.click(Math.max(0, Math.min(1279, msg.x)), Math.max(0, Math.min(799, msg.y)),
            { button: ['left', 'right', 'middle'].includes(msg.button) ? msg.button : 'left',
              clickCount: msg.double ? 2 : 1 });
        } else if (msg.type === 'scroll' && Number.isFinite(msg.dx) && Number.isFinite(msg.dy)) {
          await page.mouse.wheel(Math.max(-3000, Math.min(3000, msg.dx)), Math.max(-3000, Math.min(3000, msg.dy)));
        } else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.length <= 100) {
          await page.keyboard.insertText(msg.text);
        } else if (msg.type === 'key' && typeof msg.key === 'string' && msg.key.length < 40) {
          await page.keyboard.press(msg.key, { timeout: 3000 });
        }
      } catch (err) {
        send(ws, { type: 'error', message: err?.message?.slice(0, 150) || '操作に失敗しました' });
      } finally {
        busy = false;
      }
    });

    // Screenshots only: the visitor's browser does not load the remote site's HTML/CSS/JS.
    const frames = (async () => {
      while (alive && ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount < 1_000_000) {
          try {
            const jpg = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 8000 });
            send(ws, { type: 'frame', jpg: jpg.toString('base64') });
          } catch {
            if (alive) send(ws, { type: 'error', message: '画面の取得に失敗しました' });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, FRAME_INTERVAL_MS));
      }
    })();
    await stopped;
    await frames;
  } catch (err) {
    console.error('Browser session error:', err);
    send(ws, { type: 'error', message: 'ブラウザを起動できませんでした: ' + (err?.message || '').split('\n')[0].slice(0, 200) });
    ws.close(1011, 'Browser error');
  } finally {
    alive = false;
    if (context) await context.close().catch(() => {});
    activeSessions -= 1;
  }
});

process.on('SIGTERM', async () => {
  for (const client of wss.clients) client.close(1001, 'Server shutdown');
  const browser = await browserPromise?.catch(() => null);
  await browser?.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
});
server.listen(PORT, '0.0.0.0', () => console.log('Remote browser server listening on :' + PORT));
