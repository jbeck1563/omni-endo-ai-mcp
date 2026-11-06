/**
 * Self-check for get_controliq_review. Reuses the synthetic Tandem fixture
 * (real Glooko key sets, fabricated values) through the real ingest and MCP
 * tool. Nothing touches the network.
 *   node --no-warnings test-controliq.mjs
 */
import assert from 'node:assert';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixture = JSON.parse(
  readFileSync(new URL('./test-tandem.fixture.json', import.meta.url))
);
process.env.OMNI_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'omni-')), 't.db');
process.env.GLOOKO_EMAIL = 'stub@example.test';
process.env.GLOOKO_PASSWORD = 'stub';
globalThis.__OMNI_FETCH_STUB__ = (startDate, endDate) => ({ startDate, endDate, ...fixture });

const { pullAndIngest } = await import('./src/range.js');
const { createServer } = await import('./src/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

await pullAndIngest('2001-03-10T00:00:00.000Z', '2001-03-12T00:00:00.000Z');
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

// Third day (03-12) has no data at all: it must be flagged, not averaged.
const rv = await call('get_controliq_review', {
  start: '2001-03-10T00:00:00.000Z',
  end: '2001-03-13T00:00:00.000Z',
});
const mins = (d) => Object.fromEntries(Object.entries(d.modes).map(([k, v]) => [k, v.minutes]));

// 1. Each day sums to 24 h, with exclusive modes.
for (const d of rv.days) assert.strictEqual(Object.values(mins(d)).reduce((x, y) => x + y), 1440, d.date);
assert.deepStrictEqual(mins(rv.days[0]), { manual: 0, exercise: 60, sleep: 420, automatic: 960, other: 0, unknown: 0 });
assert.deepStrictEqual(mins(rv.days[1]), { manual: 120, exercise: 0, sleep: 360, automatic: 960, other: 0, unknown: 0 });

// 2. Bolus split and TDD per day.
assert.deepStrictEqual(
  rv.days.slice(0, 2).map((d) => [d.autoBolus, d.manualBolusUnits, d.totalDailyDose, d.autoBolusShareOfTddPercent]),
  [
    [{ count: 2, units: 2 }, 11.5, 37.5, 5.3],
    [{ count: 1, units: 1 }, 2, 27, 3.7],
  ]
);

// 3. The empty day is incomplete with reasons and kept out of the aggregates.
assert.strictEqual(rv.days[2].complete, false);
assert.deepStrictEqual(rv.days[2].incompleteReasons, [
  'no pump-mode data for 1440 min',
  'no Glooko daily insulin total',
]);
assert.deepStrictEqual(
  { ...rv.summary, meanModePercent: undefined },
  {
    daysInWindow: 3,
    completeDays: 2,
    incompleteDays: ['2001-03-12'],
    confidence: 'low',
    meanModePercent: undefined,
    meanAutoBolusPerDay: { count: 1.5, units: 1.5 },
    meanManualBolusUnitsPerDay: 6.75,
    meanTotalDailyDose: 32.25,
    autoBolusShareOfTddPercent: 4.7,
  }
);
assert.strictEqual(rv.summary.meanModePercent.sleep, 27.1);

// 4. Hour-of-day aggregates carry n and the days-with-auto-bolus count.
const h = (i) => rv.byHour[i];
assert.strictEqual(rv.byHour.length, 24);
assert.deepStrictEqual(h(3).autoBolus, { count: 1, units: 1.25, daysWithAutoBolus: 1 });
assert.strictEqual(h(3).nDays, 2);
assert.strictEqual(h(3).modePercent.sleep, 100);
assert.strictEqual(h(12).modePercent.manual, 50);
assert.strictEqual(rv.byHour.reduce((x, y) => x + y.autoBolus.count, 0), 3);

// 5. Caveat rule and the explicit basal-vs-profile gap.
assert.match(rv.caveat, /Discuss with your endocrinologist before changing settings/);
assert.strictEqual(rv.basalVsProfile.available, false);
assert.match(rv.basalVsProfile.missing, /no delivered basal RATE/);
assert.strictEqual(rv.basalVsProfile.profileBasalSegmentsStored, false);

// 6. Partial-window days are flagged too.
const part = await call('get_controliq_review', {
  start: '2001-03-10T12:00:00.000Z',
  end: '2001-03-11T00:00:00.000Z',
});
assert.strictEqual(part.days.length, 1);
assert.ok(part.days[0].incompleteReasons.includes('day only partly inside the window'));
assert.strictEqual(part.summary.completeDays, 0);

// 7. Glooko rounds its daily bolus to 0.1 U: a 0.05 U gap is not flagged, 0.1 U is.
const { buildControlIqReview } = await import('./src/analytics.js');
const mismatch = (glookoBolus) =>
  buildControlIqReview(
    {
      pumpModes: [{ mode: 'automatic', startEpoch: 0, endEpoch: 86400 }],
      timeline: [{ type: 'BOLUS', epoch: 3600, units: 1.65, class: 'Meal Bolus' }],
      dailyInsulin: [{ dayUtc: '1970-01-01', bolusUnits: glookoBolus, totalUnits: 10, complete: true }],
    },
    0,
    86400
  ).days[0].complete;
assert.strictEqual(mismatch(1.7), true);
assert.strictEqual(mismatch(1.75), false);

console.log('OK: get_controliq_review');
process.exit(0);
