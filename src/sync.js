/**
 * Sync engine.
 *
 * One shared module for getting Glooko data into the archive, used by both the
 * MCP server (on its first tool call, and on explicit refresh) and the
 * standalone warm-up CLI. Having a single engine means the cold-start, top-up
 * and staleness logic is identical however it is triggered, so there is one
 * code path to trust.
 *
 * Design decisions (see the long discussion that produced this):
 *
 *  - COLD START walks forward from an env floor date (OMNI_OLDEST_DATE) in
 *    one-year batches, so no single Glooko request spans a huge range. It is
 *    RECENT-FIRST: the most recent batch is pulled and ingested before the
 *    older history, so the very first question is answerable quickly while the
 *    backfill continues.
 *
 *  - TOP-UP keys off the OLDEST of the per-stream maxima (store.getStreamMaxima
 *    -> coverageEpoch), NOT CGM recency alone. If one stream lagged a Glooko
 *    sync, keying off CGM would leave it permanently behind. A short trailing
 *    re-pull window also corrects late/provisional boundary readings.
 *
 *  - An in-process LOCK (syncInProgress) serialises everything. A query that
 *    arrives mid-pull awaits the same promise rather than starting a second
 *    Glooko session or reading a half-written DB. This is the single safeguard
 *    that makes background backfill and foreground reads coexist safely.
 *
 *  - STALENESS is reported, never auto-actioned mid-session. Tools call
 *    describeStaleness() and surface the flag; the user chooses to refresh,
 *    which calls topUp() (same engine). The only automatic pull is the one at
 *    first-call cold start / initial top-up.
 */

import {
  pullAndIngest,
  startOfTodayEpochSeconds,
} from './range.js';
import {
  getStreamMaxima,
  getNewestDataEpoch,
  getEarliestCgmEpoch,
  getCgmCount,
} from './store.js';

const YEAR_SECONDS = 365 * 86400;
// Default amount of history to acquire on a fresh install when OMNI_OLDEST_DATE
// is not set: 3 months back from "now" (computed at runtime). This keeps a
// first run fast and is the amount shipped in the example database. Users who
// want more set OMNI_OLDEST_DATE to an earlier date to override it.
const DEFAULT_HISTORY_SECONDS = 90 * 86400;

// How stale (seconds) the newest data may be before tools warn the user.
// Two hours, per the spec: long enough not to nag during a working session,
// short enough to catch a server that has been idle.
export const STALENESS_THRESHOLD_SECONDS = 2 * 60 * 60;

// Trailing window always re-pulled on a top-up, so the partial current day and
// any late boundary readings are refreshed even if "coverage" looks current.
const TOPUP_TRAILING_SECONDS = 2 * 86400;

// Stop the cold-start backfill after this many CONSECUTIVE empty year-batches,
// so a user who sets OMNI_OLDEST_DATE far too early does not trigger an endless
// walk through years Glooko has no data for. Also used by the older-gap
// backfill in range.js (a wide orientation probe is the same shape of problem).
export const MAX_EMPTY_BATCHES = 2;

// --- the lock -------------------------------------------------------------
// A single in-flight sync promise. Anything that would pull awaits this first.
let syncInProgress = null;

/**
 * Run `fn` under the sync lock. If a sync is already running, await THAT one
 * instead of starting a second (the caller still gets a resolved promise when
 * the in-flight work finishes). Returns whatever the active run returns.
 */
export function withSyncLock(fn) {
  if (syncInProgress) return syncInProgress;
  syncInProgress = (async () => {
    try {
      return await fn();
    } finally {
      syncInProgress = null;
    }
  })();
  return syncInProgress;
}

/** True if a sync is currently running. */
export function isSyncing() {
  return syncInProgress !== null;
}

// --- env floor date -------------------------------------------------------

/**
 * The oldest date the cold start will reach back to, from OMNI_OLDEST_DATE.
 * Validated hard: a malformed value would corrupt every batch boundary, so we
 * fail loudly rather than silently defaulting to an absurd range. If unset,
 * falls back to 3 months before today (computed from the current system date at
 * runtime), which is the amount shipped in the example database.
 */
export function resolveOldestEpoch() {
  const raw = process.env.OMNI_OLDEST_DATE;
  if (!raw || !raw.trim()) {
    // Default floor: 3 months before today, using the current system date.
    return Math.floor(Date.now() / 1000) - DEFAULT_HISTORY_SECONDS;
  }
  const parsed = Date.parse(raw.trim());
  if (Number.isNaN(parsed)) {
    throw new Error(
      `OMNI_OLDEST_DATE is not a valid date: ${JSON.stringify(raw)}. ` +
        `Use an ISO date like 2024-01-01.`
    );
  }
  const epoch = Math.floor(parsed / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (epoch > now) {
    throw new Error(
      `OMNI_OLDEST_DATE (${raw}) is in the future. It must be a past date.`
    );
  }
  return epoch;
}

// --- batch helpers --------------------------------------------------------

/**
 * Build forward-walking one-year [startEpoch, endEpoch] batches spanning
 * [fromEpoch, toEpoch]. The final batch is clamped to toEpoch. Batches abut;
 * idempotent ingest tolerates the shared boundary day.
 */
export function yearBatches(fromEpoch, toEpoch) {
  const batches = [];
  let cursor = fromEpoch;
  while (cursor < toEpoch) {
    const end = Math.min(cursor + YEAR_SECONDS, toEpoch);
    batches.push([cursor, end]);
    cursor = end;
  }
  return batches;
}

const iso = (epoch) => new Date(epoch * 1000).toISOString();

/**
 * Pull one batch and report whether it produced any NEW stored CGM rows. Used
 * by the cold start to detect runs of empty (pre-history) batches. Compares the
 * exact CGM row count before and after, so detection is unambiguous (the
 * earliest-epoch heuristic could misfire on abutting boundaries).
 */
export async function pullBatch(startEpoch, endEpoch) {
  const before = getCgmCount();
  await pullAndIngest(iso(startEpoch), iso(endEpoch));
  const after = getCgmCount();
  return after > before;
}

// --- cold start -----------------------------------------------------------

/**
 * Full historical load for an empty archive. RECENT-FIRST: pulls the most
 * recent year batch first (so the first question is answerable), then walks the
 * remaining batches from newest to oldest, stopping after MAX_EMPTY_BATCHES
 * consecutive empty pulls (older than the user actually has data for).
 *
 * Caller is responsible for the lock (use ensureFreshOnFirstCall / runColdStart
 * which wrap this). onProgress(msg) is optional, used by the CLI to log.
 */
export async function coldStart(onProgress = () => {}) {
  const oldest = resolveOldestEpoch();
  const now = Math.floor(Date.now() / 1000);
  const batches = yearBatches(oldest, now);
  if (!batches.length) return;

  // Recent-first: reverse so the newest batch is pulled first.
  const ordered = [...batches].reverse();

  let consecutiveEmpty = 0;
  for (let i = 0; i < ordered.length; i++) {
    const [s, e] = ordered[i];
    onProgress(
      `cold-start batch ${i + 1}/${ordered.length}: ${iso(s).split('T')[0]} .. ${iso(e).split('T')[0]}`
    );
    const produced = await pullBatch(s, e);
    if (produced) {
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty += 1;
      onProgress(`  (no data in batch; ${consecutiveEmpty} consecutive empty)`);
      if (consecutiveEmpty >= MAX_EMPTY_BATCHES) {
        onProgress(
          `  stopping backfill: ${MAX_EMPTY_BATCHES} consecutive empty batches (reached pre-history)`
        );
        break;
      }
    }
  }
}

// --- top-up ---------------------------------------------------------------

/**
 * Bring an existing archive up to now. Pulls from the OLDEST stream max (so a
 * lagging stream is caught) minus a trailing safety window, up to now. No-op
 * for the historical portion if everything is already current; the trailing
 * window is always re-pulled so the partial day and late readings refresh.
 *
 * Caller holds the lock (use runTopUp).
 */
export async function topUp(onProgress = () => {}) {
  const { coverageEpoch } = getStreamMaxima();
  const now = Math.floor(Date.now() / 1000);

  if (coverageEpoch === null) {
    // Empty archive: this is really a cold start.
    onProgress('archive empty; performing cold start instead of top-up');
    await coldStart(onProgress);
    return;
  }

  const start = Math.max(0, coverageEpoch - TOPUP_TRAILING_SECONDS);
  if (now <= start) {
    onProgress('archive already current; nothing to top up');
    return;
  }
  onProgress(`top-up: ${iso(start).split('T')[0]} .. ${iso(now).split('T')[0]}`);
  await pullAndIngest(iso(start), iso(now));
}

// --- locked public entry points -------------------------------------------

/** Cold start under the lock. */
export function runColdStart(onProgress) {
  return withSyncLock(() => coldStart(onProgress));
}

/** Top-up under the lock. */
export function runTopUp(onProgress) {
  return withSyncLock(() => topUp(onProgress));
}

/**
 * First-call entry for the server: if the archive is empty, cold start;
 * otherwise top up. Returns when the archive is usable. If a sync is already
 * running (e.g. a background cold start), awaits it rather than duplicating.
 */
export function ensureFreshOnFirstCall(onProgress = () => {}) {
  return withSyncLock(async () => {
    const { coverageEpoch } = getStreamMaxima();
    if (coverageEpoch === null) {
      await coldStart(onProgress);
    } else {
      await topUp(onProgress);
    }
  });
}

// --- staleness reporting --------------------------------------------------

/**
 * Describe how fresh the archive is, for tools to surface to the user. Never
 * triggers a pull. Returns:
 *   { newestEpoch, ageSeconds, ageHours, stale, hint } or
 *   { empty: true, ... } when there is no data at all.
 */
export function describeStaleness() {
  const newest = getNewestDataEpoch();
  if (newest === null) {
    return {
      empty: true,
      stale: true,
      hint: 'No data has been loaded yet. Ask to load data to populate the archive.',
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, now - newest);
  const ageHours = Math.round((ageSeconds / 3600) * 10) / 10;
  const stale = ageSeconds > STALENESS_THRESHOLD_SECONDS;
  return {
    empty: false,
    newestEpoch: newest,
    newestIso: iso(newest),
    ageSeconds,
    ageHours,
    stale,
    syncing: isSyncing(),
    hint: stale
      ? `Data is ${ageHours}h old. Ask to refresh to pull the latest from Glooko.`
      : undefined,
  };
}
