/**
 * http.js — the HTTP / SSE entry point.
 *
 * An ALTERNATIVE transport to the default stdio (src/server.js). It exposes the
 * same tools and the same sync engine, but over Streamable HTTP instead of
 * stdio. Streamable HTTP is the current MCP HTTP transport; it provides the SSE
 * streaming endpoint that environments ask for (the legacy standalone HTTP+SSE
 * transport is deprecated).
 *
 * STATEFUL, MULTI-CLIENT SAFE. Each client session gets its OWN transport,
 * created on the `initialize` request and keyed by the session id the SDK
 * generates. Subsequent requests carry that id in the `Mcp-Session-Id` header
 * and are routed back to the same transport; on close the transport is removed.
 * A single shared transport cannot do this (it would cross client sessions), so
 * we keep a sessionId -> transport map, and build a SEPARATE McpServer per
 * session (the SDK forbids one server on multiple transports).
 *
 * Launch this instead of stdio by running `node src/http.js` (the Docker image
 * selects transport via env, see Dockerfile / OMNI_TRANSPORT).
 *
 * SECURITY: intended for LOCAL use (same machine / local Docker network). It
 * binds 127.0.0.1 by default. If OMNI_HTTP_TOKEN is set, every request must
 * carry `Authorization: Bearer <token>`; if unset, it runs open (acceptable
 * only on a trusted local interface). Do NOT bind 0.0.0.0 or expose the port
 * off-host without a token and TLS: it serves health data and can trigger
 * Glooko pulls.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { glookoConfigured } from './range.js';
import { fetchGlookoRange } from './glooko.js';
import { ensureFreshOnFirstCall } from './sync.js';
import { initDb } from './store.js';

const PORT = parseInt(process.env.OMNI_HTTP_PORT || '3000', 10);
const HOST = process.env.OMNI_HTTP_HOST || '127.0.0.1';
const MCP_PATH = process.env.OMNI_HTTP_PATH || '/mcp';
const TOKEN = process.env.OMNI_HTTP_TOKEN || null;

// Optional raw-passthrough route for the omni-endo-ai web UI. That app POSTs
// /my-data with browser-typed Glooko credentials and expects back the three raw
// Glooko payloads. fetchGlookoRange() already returns exactly that shape, so
// serving it here lets the UI drop its own login entirely: one Glooko session
// for the whole house instead of two, and no credentials in the browser.
//
// Off by default. It is deliberately NOT behind OMNI_HTTP_TOKEN (a browser
// can't send a Bearer), so enabling it opens an unauthenticated route that
// triggers live Glooko pulls with the server's own credentials. LAN only.
const MYDATA = process.env.OMNI_MYDATA === '1';

// sessionId -> transport. One transport per live client session. The MCP server
// is connected once to each transport when the session is created.
const transports = Object.create(null);

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function badRequest(res, message) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message || 'bad request' }));
}

// Read and JSON-parse a request body (for POST). Returns undefined for empty.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function tokenOk(req) {
  if (!TOKEN) return true; // open mode (local, trusted interface only)
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${TOKEN}`;
}

// Is this parsed POST body an MCP `initialize` request? Initialize is the only
// request allowed to arrive WITHOUT a session id; it mints a new session.
function isInitialize(body) {
  if (!body) return false;
  if (Array.isArray(body)) return body.some((m) => m && m.method === 'initialize');
  return body.method === 'initialize';
}

// Create a fresh transport for a new session, connect the shared server to it,
// and register it in the map once the SDK assigns a session id.
async function createSessionTransport() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      transports[sessionId] = transport;
    },
    onsessionclosed: (sessionId) => {
      delete transports[sessionId];
    },
  });
  // Also clean up if the transport closes for any other reason.
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && transports[sid]) delete transports[sid];
  };
  // Each session needs its OWN server instance: the SDK forbids connecting one
  // server to multiple transports.
  const sessionServer = createServer();
  await sessionServer.connect(transport);
  return transport;
}

// POST /my-data — { startDate, endDate } -> { startDate, endDate, data1, data2, data3 }.
// Credentials in the body (which the UI still sends) are ignored: this always uses
// GLOOKO_EMAIL / GLOOKO_PASSWORD from the environment.
async function handleMyData(req, res) {
  if (req.method !== 'POST') return notFound(res);
  if (!glookoConfigured()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        error: 'Offline mode: no Glooko credentials configured on the server.',
      })
    );
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return badRequest(res, 'invalid JSON body');
  }
  const { startDate, endDate } = body || {};
  if (!startDate || !endDate) {
    return badRequest(res, 'startDate and endDate are required');
  }

  try {
    const result = await fetchGlookoRange(startDate, endDate);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[omni-endo-ai] /my-data failed:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (MYDATA && url.pathname === '/my-data') return handleMyData(req, res);
  if (url.pathname !== MCP_PATH) return notFound(res);
  if (!tokenOk(req)) return unauthorized(res);

  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const sessionId =
      req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'];

    let transport;
    if (sessionId && transports[sessionId]) {
      // Existing session: route to its own transport.
      transport = transports[sessionId];
    } else if (!sessionId && req.method === 'POST' && isInitialize(body)) {
      // New session: an initialize POST with no session id mints one.
      transport = await createSessionTransport();
    } else {
      // A non-initialize request without a known session id. In stateful mode
      // this is invalid: either the session expired/never existed (provided an
      // id we do not hold) or a non-init request arrived with no id at all.
      if (sessionId) return notFound(res); // unknown/expired session
      return badRequest(res, 'missing session id (no active session)');
    }

    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[omni-endo-ai] HTTP request error:', err);
    if (!res.headersSent) badRequest(res);
  }
});

function main() {
  httpServer.listen(PORT, HOST, () => {
    console.error(
      `[omni-endo-ai] MCP server running on http://${HOST}:${PORT}${MCP_PATH} (Streamable HTTP / SSE, stateful).`
    );
    if (!TOKEN) {
      console.error(
        '[omni-endo-ai] WARNING: OMNI_HTTP_TOKEN is not set, the endpoint is ' +
          'unauthenticated. Only acceptable on a trusted local interface.'
      );
    }
    if (HOST === '0.0.0.0' && !TOKEN) {
      console.error(
        '[omni-endo-ai] WARNING: bound to 0.0.0.0 WITHOUT a token. Your health ' +
          'data is exposed to the network. Set OMNI_HTTP_TOKEN.'
      );
    }

    // Warm the archive on startup so the data is present right after
    // `docker compose up`, not only after the first tool call. Runs AFTER the
    // server is already listening (above), so the container is reachable
    // promptly and the load fills in behind it. Skipped entirely in offline
    // mode (no credentials), where we must never contact Glooko. A failure here
    // (e.g. bad credentials) is logged but never crashes the server: tool calls
    // will retry the load and surface the error to the user.
    if (glookoConfigured()) {
      console.error(
        '[omni-endo-ai] Warming archive on startup (cold start if empty, else top-up)...'
      );
      // Fire and forget: do not block the event loop / listener.
      (async () => {
        try {
          initDb();
          await ensureFreshOnFirstCall((m) => console.error(`[omni-endo] ${m}`));
          console.error('[omni-endo-ai] Startup archive warm-up complete.');
        } catch (err) {
          console.error(
            '[omni-endo-ai] Startup warm-up failed (will retry on first tool call):',
            err.message
          );
        }
      })();
    } else {
      console.error(
        '[omni-endo-ai] No Glooko credentials: running in OFFLINE mode, serving ' +
          'only the existing database. No data will be downloaded.'
      );
    }
  });
}

main();
