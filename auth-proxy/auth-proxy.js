/**
 * Auth-Proxy — Authenticated scraping via the login station's Chrome CDP.
 *
 * HOW IT WORKS
 * ────────────
 * The login-station container runs two services:
 *   1. Chrome (port 9222) — managed by linuxserver/chromium base image
 *   2. Auth-proxy (this process) — managed by s6-rc
 *
 * Both share the SAME Chrome instance. When a user signs into a site via
 * KasmVNC at login.YOUR_DOMAIN, the auth-proxy inherits those cookies
 * automatically via CDP. No cookie extraction needed.
 *
 * CDP WebSocket proxy (port 9224):
 *   External clients (e.g. browserless CONNECTION_WS_ENDPOINT) can connect
 *   here to drive the SAME Chrome session. The proxy rewrites Chrome's WS URL
 *   so clients connect back through it, enabling session sharing across
 *   containers on the same Docker network.
 *
 * ENVIRONMENT VARIABLES
 * ─────────────────────
 *   PORT              — HTTP port for the scrape API  (default: 3100)
 *   CDP_HOST          — Chrome/Chrome CDP host        (default: 127.0.0.1)
 *   CDP_PORT          — Chrome CDP HTTP port           (default: 9222)
 *   CDP_PROXY_PORT    — CDP WebSocket proxy port      (default: 9224)
 *
 * API ENDPOINTS
 * ──────────────
 *   GET  /health              — Returns { ok, browser, pages, cdpUrl }
 *   POST /scrape              — JSON body: { url, waitAfter, timeout, waitUntil }
 *   GET  /scrape?url=...      — Query params: url, waitAfter, waitUntil
 */

import express from 'express';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import http from 'http';

const PORT        = parseInt(process.env.PORT            || '3100', 10);
const CDP_PROXY   = parseInt(process.env.CDP_PROXY_PORT || '9224', 10);
const CDP_HOST    = process.env.CDP_HOST  || '127.0.0.1';
const CDP_PORT    = parseInt(process.env.CDP_PORT || '9222', 10);
const CDP_API_URL = `http://${CDP_HOST}:${CDP_PORT}`;

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── CDP Helpers ─────────────────────────────────────────────────────────────

/** Fetch the Chrome DevTools WebSocket debugger URL. */
async function resolveWsEndpoint() {
  const resp = await fetch(`${CDP_API_URL}/json/version`);
  if (!resp.ok) throw new Error(`CDP /json/version returned ${resp.status}`);
  const data = await resp.json();
  const wsUrl = data.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('No webSocketDebuggerUrl in CDP response');
  // Replace localhost/127.0.0.1 with the configured CDP_HOST so the
  // WebSocket connects to the right container on the Docker network.
  return wsUrl.replace(/localhost|127\.0\.0\.1/gi, CDP_HOST);
}

// ── Scrape via CDP ──────────────────────────────────────────────────────────

/**
 * Open a URL in the login-station Chrome and return HTML + metadata.
 * Sessions/cookies are inherited because it's the SAME Chrome instance.
 *
 * @param {string}   url        — Target URL
 * @param {object}   options
 * @param {number}   options.waitAfter   — Extra ms to wait after load
 * @param {string}   options.waitUntil   — Puppeteer waitUntil strategy
 * @param {number}   options.timeout     — Navigation timeout (ms)
 */
async function scrapeViaCDP(url, options = {}) {
  const wsEndpoint = await resolveWsEndpoint();
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, timeout: 30000 });

  try {
    const page = await browser.newPage();
    const waitUntil = options.waitUntil || 'networkidle2';
    const timeout   = options.timeout   || 30000;

    await page.goto(url, { waitUntil, timeout }).catch(e => {
      console.warn(`⚠️  Navigation warning for ${url}: ${e.message}`);
    });

    if (options.waitAfter) {
      await new Promise(r => setTimeout(r, options.waitAfter));
    }

    const html     = await page.content();
    const title    = await page.title();
    const finalUrl = page.url();

    await page.close().catch(() => {});

    return { html, title, finalUrl };
  } finally {
    await browser.disconnect();
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** Health check — verifies Chrome CDP is reachable. */
app.get('/health', async (req, res) => {
  try {
    const wsEndpoint = await resolveWsEndpoint();
    const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, timeout: 10000 });
    const pages   = await browser.pages();
    const version = await browser.version();
    await browser.disconnect();
    res.json({ ok: true, browser: version, pages: pages.length, cdpUrl: CDP_API_URL });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message, cdpUrl: CDP_API_URL });
  }
});

/** POST /scrape — JSON body */
app.post('/scrape', async (req, res) => {
  const { url, waitAfter, timeout, waitUntil } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    console.log(`[auth-proxy] Scraping: ${url}`);
    const result = await scrapeViaCDP(url, { waitAfter, timeout, waitUntil });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[auth-proxy] Scrape failed for ${url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** GET /scrape?url=...&waitAfter=2000 — returns raw HTML */
app.get('/scrape', async (req, res) => {
  const url      = req.query.url;
  const waitAfter = parseInt(req.query.waitAfter || '2000', 10);
  if (!url) return res.status(400).json({ error: '?url= is required' });

  try {
    console.log(`[auth-proxy] Scraping: ${url}`);
    const result = await scrapeViaCDP(url, { waitAfter });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(result.html);
  } catch (err) {
    console.error(`[auth-proxy] Scrape failed for ${url}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── CDP WebSocket Proxy ─────────────────────────────────────────────────────
//
// Allows external tools (e.g. browserless with CONNECTION_WS_ENDPOINT) to
// connect to the login-station Chrome over WebSocket, inheriting sessions.
//
// HOW IT WORKS
// Chrome exposes CDP HTTP endpoints at :9222/json/* that return WebSocket
// URLs pointing back to itself (e.g. ws://127.0.0.1:9222/..."). External
// clients can't reach that. The proxy intercepts those HTTP responses,
// rewrites the WS URLs to point to :CDP_PROXY (which IS reachable), and
// then tunnels traffic from clients to Chrome.
//
//  External client (browserless)
//        │
//        ▼  HTTP GET /json/version
//  ┌─────────────────────────────────┐
//  │  CDP HTTP server (this process) │  :CDP_PROXY
//  │  rewrites ws://... → :CDP_PROXY │
//  └──────────────┬──────────────────┘
//                 │  HTTP GET /json/version (proxied)
//                 ▼
//          Chrome :9222/json/version
//                 │
//                 ▼  Response body rewritten:
//          ws://127.0.0.1:9222/... → ws://CDP_HOST:CDP_PROXY/...
//                 │
//                 ▼  WS upgrade
//  ┌─────────────────────────────────┐
//  │  CDP WS proxy (this process)    │  :CDP_PROXY
//  │  tunnels client ↔ Chrome WS     │
//  └──────────────┬──────────────────┘
//                 │  WS connect
//                 ▼
//          Chrome CDP WS (same Chrome as KasmVNC!)
//

const cdpHttpServer = http.createServer(async (req, res) => {
  const upstream = `${CDP_API_URL}${req.url}`;
  try {
    const r = await fetch(upstream, {
      method:  req.method,
      headers: { host: `127.0.0.1:${CDP_PORT}` },
      body:    ['POST', 'PUT', 'PATCH'].includes(req.method)
                 ? req : undefined,
    });
    const body = await r.text();

    // Rewrite WebSocket URLs so clients connect back through this proxy
    const rewritten = body
      .replace(/127\.0\.0\.1:[0-9]+/g, `${CDP_HOST}:${CDP_PROXY}`)
      .replace(/localhost:[0-9]+/gi,  `${CDP_HOST}:${CDP_PROXY}`);

    res.writeHead(r.status, {
      'content-type': r.headers.get('content-type') || 'application/json',
    });
    res.end(rewritten);
  } catch (e) {
    res.writeHead(502);
    res.end(e.message);
  }
});

const wss = new WebSocketServer({ server: cdpHttpServer });

wss.on('connection', async (clientWs, req) => {
  console.log('[auth-proxy] CDP WS client connected');

  // Buffer early messages sent before we finish connecting upstream
  const earlyBuf = [];
  clientWs.on('message', (data) => earlyBuf.push(data));

  try {
    const targetUrl = await resolveWsEndpoint();
    console.log(`[auth-proxy]  → Proxying to Chrome WS: ${targetUrl}`);

    const targetWs = new WebSocket(targetUrl);

    await new Promise((resolve, reject) => {
      targetWs.onopen    = resolve;
      targetWs.onerror   = () => reject(new Error('CDP target connect failed'));
      setTimeout(() => reject(new Error('CDP connect timeout')), 15000);
    });

    // Helper: CDP protocol is JSON text frames, not binary
    const toText = (data) => Buffer.isBuffer(data) ? data.toString('utf-8') : data;

    // Drain buffered messages into Chrome
    for (const msg of earlyBuf) {
      try { targetWs.send(toText(msg)); } catch {}
    }

    // Replace early-buffer handler with live forwarding
    clientWs.removeAllListeners('message');
    clientWs.on('message', (data) => { try { targetWs.send(toText(data)); } catch {} });

    // Rewrite WS URL in CDP responses so subsequent CDP clients connect via proxy
    targetWs.onmessage = (evt) => {
      try {
        const raw = toText(evt.data);
        if (raw.startsWith('{') || raw.startsWith('[')) {
          const rewritten = raw.replace(
            /"webSocketDebuggerUrl"\s*:\s*"ws:\/\/[^"]+"/g,
            () => `"webSocketDebuggerUrl":"ws://${CDP_HOST}:${CDP_PROXY}/"`
          );
          clientWs.send(rewritten);
        } else {
          clientWs.send(raw);
        }
      } catch {
        clientWs.send(evt.data);
      }
    };

    targetWs.onclose  = () => clientWs.close();
    clientWs.on('close', () => targetWs.close());

    targetWs.onerror = (e) => {
      console.error('[auth-proxy] CDP WS target error:', e.message);
      try { clientWs.close(1011); } catch {}
    };
    clientWs.on('error', (e) => {
      console.error('[auth-proxy] CDP WS client error:', e.message);
      try { targetWs.close(); } catch {}
    });

  } catch (err) {
    console.error(`[auth-proxy] CDP proxy error: ${err.message}`);
    try { clientWs.close(1011, err.message); } catch {}
  }
});

cdpHttpServer.listen(CDP_PROXY, '0.0.0.0', () => {
  console.log(`[auth-proxy] CDP WebSocket proxy listening on :${CDP_PROXY}`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[auth-proxy] Authenticated scrape API listening on :${PORT}`);
  console.log(`[auth-proxy] Chrome CDP endpoint: ${CDP_API_URL}`);
});