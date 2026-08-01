/**
 * Self-check for the /my-data passthrough route (src/http.js).
 * Stubs the Glooko fetch so nothing touches the network.
 *   node test-mydata.mjs
 */
import assert from 'node:assert';

process.env.OMNI_MYDATA = '1';
process.env.OMNI_HTTP_PORT = '38033';
process.env.OMNI_HTTP_HOST = '127.0.0.1';
process.env.OMNI_HTTP_TOKEN = 'test-token';
process.env.GLOOKO_EMAIL = 'stub@example.test';
process.env.GLOOKO_PASSWORD = 'stub';

// fetchGlookoRange honours this seam and never hits the network (src/glooko.js:239).
globalThis.__OMNI_FETCH_STUB__ = (startDate, endDate) => ({
  startDate,
  endDate,
  data1: { series: [] },
  data2: { stats: 'ok' },
  data3: { devices: [] },
});

await import('./src/http.js');
await new Promise((r) => setTimeout(r, 300));

const base = 'http://127.0.0.1:38033';
const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// 1. Happy path: no Authorization header, returns the exact shape the UI expects.
const ok = await post('/my-data', {
  username: 'ignored',
  password: 'ignored',
  startDate: '2026-07-01T00:00:00.000Z',
  endDate: '2026-07-08T00:00:00.000Z',
});
assert.strictEqual(ok.status, 200);
const body = await ok.json();
assert.deepStrictEqual(Object.keys(body).sort(), [
  'data1',
  'data2',
  'data3',
  'endDate',
  'startDate',
]);
assert.strictEqual(body.startDate, '2026-07-01T00:00:00.000Z');

// 2. Missing dates -> 400, not a Glooko call.
const bad = await post('/my-data', { username: 'x', password: 'y' });
assert.strictEqual(bad.status, 400);

// 3. GET -> 404 (POST only).
assert.strictEqual((await fetch(base + '/my-data')).status, 404);

// 4. The MCP path still requires the bearer token.
assert.strictEqual((await post('/mcp', { method: 'initialize' })).status, 401);

console.log('OK: /my-data passthrough');
// http.js owns the listener and never exports it, so there is nothing to close;
// exit on the next tick, once the response sockets have unwound.
setTimeout(() => process.exit(0), 100);
