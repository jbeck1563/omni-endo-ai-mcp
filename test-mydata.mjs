/**
 * Self-check for the /my-data passthrough route (src/http.js).
 * Stubs the Glooko fetch so nothing touches the network.
 *   node test-mydata.mjs
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

// Re-exec of ourselves with no OMNI_MYDATA_BASIC, to prove the route fails
// closed rather than serving glucose data to an anonymous caller. Runs in a
// child because the env is read once at module load.
const NOBASIC = process.env.OMNI_TEST_NOBASIC === '1';

process.env.OMNI_MYDATA = '1';
process.env.OMNI_HTTP_PORT = NOBASIC ? '38034' : '38033';
process.env.OMNI_HTTP_HOST = '127.0.0.1';
process.env.OMNI_HTTP_TOKEN = 'test-token';
if (NOBASIC) delete process.env.OMNI_MYDATA_BASIC;
else process.env.OMNI_MYDATA_BASIC = 'mcp:s3cret';
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

const base = `http://127.0.0.1:${process.env.OMNI_HTTP_PORT}`;
const BASIC = 'Basic ' + Buffer.from('mcp:s3cret').toString('base64');
const post = (path, body, auth) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });

const dates = {
  startDate: '2026-07-01T00:00:00.000Z',
  endDate: '2026-07-08T00:00:00.000Z',
};

// Fail-closed child run: no credential configured, so the route must refuse
// everyone — including a caller presenting the credential the parent uses.
if (NOBASIC) {
  assert.strictEqual((await post('/my-data', dates)).status, 503);
  assert.strictEqual((await post('/my-data', dates, BASIC)).status, 503);
  console.log('OK: /my-data fails closed without OMNI_MYDATA_BASIC');
  setTimeout(() => process.exit(0), 100);
} else {

// 1. Happy path: correct Basic credential, returns the exact shape the UI expects.
const ok = await post(
  '/my-data',
  { username: 'ignored', password: 'ignored', ...dates },
  BASIC
);
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

// 2. No credential -> 401, and a realm so a browser prompts on its own.
const anon = await post('/my-data', dates);
assert.strictEqual(anon.status, 401);
assert.match(anon.headers.get('www-authenticate') || '', /^Basic realm="omni-endo"/);

// 3. Wrong credential -> 401. Also covers the equal-length case, so the compare
//    is exercised rather than short-circuited on length alone.
const wrong = 'Basic ' + Buffer.from('mcp:s3crey').toString('base64');
assert.strictEqual((await post('/my-data', dates, wrong)).status, 401);

// 4. The MCP bearer is NOT accepted here — the two credentials are separate.
assert.strictEqual(
  (await post('/my-data', dates, 'Bearer test-token')).status,
  401
);

// 5. Missing dates, authenticated -> 400, not a Glooko call.
const bad = await post('/my-data', { username: 'x', password: 'y' }, BASIC);
assert.strictEqual(bad.status, 400);

// 6. GET -> 404 (POST only).
assert.strictEqual((await fetch(base + '/my-data')).status, 404);

// 7. The MCP path still requires the bearer token.
assert.strictEqual((await post('/mcp', { method: 'initialize' })).status, 401);

  console.log('OK: /my-data passthrough');

  // Now the fail-closed case, which needs a process with a different env.
  execFileSync(process.execPath, ['--no-warnings', import.meta.filename], {
    env: { ...process.env, OMNI_TEST_NOBASIC: '1' },
    stdio: ['ignore', 'inherit', 'ignore'],
  });

  // http.js owns the listener and never exports it, so there is nothing to close;
  // exit on the next tick, once the response sockets have unwound.
  setTimeout(() => process.exit(0), 100);
}
