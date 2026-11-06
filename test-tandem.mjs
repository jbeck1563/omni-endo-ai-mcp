/**
 * Self-check for Tandem t:slim X2 / Control-IQ data arriving through Glooko.
 * Feeds test-tandem.fixture.json (synthetic: real Glooko series names and key
 * sets, fabricated values) through the real ingest and the real MCP tools.
 * Nothing touches the network.
 *   node --no-warnings test-tandem.mjs
 */
import assert from 'node:assert';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixture = JSON.parse(
  readFileSync(new URL('./test-tandem.fixture.json', import.meta.url))
);
process.env.OMNI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'omni-')), 't.db');
process.env.GLOOKO_GLUCOSE_UNIT = 'mmol';
process.env.OMNI_UNITS = 'mmol';
process.env.GLOOKO_EMAIL = 'stub@example.test';
process.env.GLOOKO_PASSWORD = 'stub';
// fetchGlookoRange honours this seam and never hits the network.
globalThis.__OMNI_FETCH_STUB__ = (startDate, endDate) => ({ startDate, endDate, ...fixture });

const { pullAndIngest } = await import('./src/range.js');
const { createServer } = await import('./src/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const start = '2001-03-10T00:00:00.000Z';
const end = '2001-03-12T00:00:00.000Z';
await pullAndIngest(start, end);
// Serve from the archive only from here on, as an offline server would.
delete process.env.GLOOKO_EMAIL;
delete process.env.GLOOKO_PASSWORD;

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} errored: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
};

// 1. Summary never throws on Tandem settings (no maxBasalRate, two profiles).
const sum = await call('get_diabetes_summary', { start, end });
assert.strictEqual(sum.insulin.bolusEventCount, 6);
assert.strictEqual(sum.insulin.bolusUnits, 16.5);
assert.deepStrictEqual(sum.bolusArchitecture, {
  meal: 1,
  manualCorrection: 0,
  systemCorrection: 1,
  mealWithCorrection: 1,
  automaticCorrection: 3,
});
assert.strictEqual(sum.settings.length, 1);
assert.strictEqual(sum.settings[0].activeProfile, 'Weekday');
assert.strictEqual(sum.settings[0].maxBasalRate, null);
assert.deepStrictEqual(sum.settings[0].targetBg, [{ from: '0:00', value: 6 }]);
assert.deepStrictEqual(sum.device, {
  pumpBrand: 'Tandem',
  pumpModel: 't:slim X2',
  cgm: 'Dexcom G7',
  algorithm: 'Control-IQ',
});

// 2. Event bolus per day matches Glooko's daily bolus totals.
const daily = await call('get_daily_insulin', { start, end });
const bolusByDay = {};
for (const x of (await call('get_enriched_bolus_log', { start, end })).boluses) {
  const d = x.time.slice(0, 10);
  bolusByDay[d] = +((bolusByDay[d] || 0) + x.units).toFixed(2);
}
for (const d of daily.days) assert.strictEqual(bolusByDay[d.date], d.bolusUnits, d.date);

// 3. Enriched bolus log uses the active profile, and the class filter works.
const auto = await call('get_enriched_bolus_log', {
  start,
  end,
  classes: ['Automatic Correction Bolus'],
});
assert.strictEqual(auto.count, 3);
assert.deepStrictEqual(auto.boluses[0].context, { DIA: 5, target: 6, isf: 2, active_cr: 10 });

// 4. Control-IQ mode time, merged across Glooko's midnight split.
const basal = await call('get_basal_delivery', { start, end });
const modes = basal.pumpModes.summary.modes;
assert.deepStrictEqual(modes.automatic, { minutes: 2760, percent: 95.8, episodes: 2 });
assert.deepStrictEqual(modes.manual, { minutes: 120, percent: 4.2, episodes: 1 });
assert.deepStrictEqual(modes.sleep, { minutes: 780, percent: 27.1, episodes: 2 });
assert.deepStrictEqual(modes.exercise, { minutes: 60, percent: 2.1, episodes: 1 });
assert.strictEqual(basal.summary.suspend.minutes, 30);
assert.strictEqual(basal.summary.suspend.episodes, 2);

// 5. Cartridge change from the "Cartridge Loaded" alarm; podChanges kept.
const dev = await call('get_device_events', { start, end });
assert.strictEqual(dev.counts.cartridgeChanges, 1);
assert.deepStrictEqual(dev.podChanges, dev.siteChanges);

console.log('OK: Tandem / Control-IQ ingest and tools');
process.exit(0);
