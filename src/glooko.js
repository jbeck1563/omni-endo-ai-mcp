/**
 * glooko.js — the Glooko API client.
 *
 * Handles authentication and data fetching against Glooko, with a deliberate
 * failure model so a bad session or a flaky network is handled correctly:
 *
 *   - Auth failure (401, or a session that has silently expired): the session
 *     is dead. Re-login ONCE, then retry. A second auth failure is terminal.
 *     This protects Glooko's login endpoint from a hammering loop when the
 *     credentials are genuinely wrong or Glooko is down.
 *
 *   - Transient failure (timeout, 5xx, network reset): the session is probably
 *     fine. Retry the SAME request with backoff, up to MAX_TRANSIENT_RETRIES,
 *     WITHOUT re-authenticating. Only if the transient retries are exhausted do
 *     we treat it as possibly-an-expired-session and allow the one re-login.
 *
 *   - Bad credentials (CREDENTIAL_MISMATCH): terminal immediately, no retry.
 *
 * There is no chunking: a requested range is fetched as a single pull. Long
 * (e.g. six-month) pulls are expensive and happen rarely; the range layer
 * caches the result so subsequent questions reuse it rather than re-fetching.
 *
 * Credentials come from the environment (GLOOKO_EMAIL / GLOOKO_PASSWORD),
 * never from tool arguments, so they never flow through the model.
 */

import originalFetch from 'node-fetch';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';

const MAX_TRANSIENT_RETRIES = 5; // patient
const MAX_RELOGIN_ATTEMPTS = 1; // strict, safest for Glooko
const RETRY_BASE_DELAY_MS = 1500;
const BASE_DOMAIN = 'https://my.glooko.com';

export const GRAPH_SERIES = [
  'cgmHigh', 'cgmLow', 'cgmNormal', 'deliveredBolus', 'automaticBolus',
  'totalInsulinPerDay',
  'basalBarAutomated', 'basalBarAutomatedSuspend', 'basalBarAutomatedMax',
  'scheduledBasal', 'temporaryBasal', 'suspendBasal', 'lgsPlgs',
  'pumpControliqAutomaticMode', 'pumpControliqManualMode',
  'pumpControliqSleepMode', 'pumpControliqExerciseMode',
  'pumpOp5AutomaticMode', 'pumpOp5ManualMode', 'pumpOp5LimitedMode',
  'pumpOp5HypoprotectMode', 'pumpGenericAutomaticMode', 'pumpGenericManualMode',
  'setSiteChange', 'reservoirChange', 'cgmSensorChange', 'pumpAlarm',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Module-scoped session cache. Lives for the life of the process.
let session = null;

function getCredentials() {
  const email = process.env.GLOOKO_EMAIL;
  const password = process.env.GLOOKO_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Glooko credentials not configured. The server expects GLOOKO_EMAIL and ' +
        'GLOOKO_PASSWORD in its environment. Create a .env file (copy .env.example) ' +
        'and load it via --env-file in your MCP client config. See the README.'
    );
  }
  return { email, password };
}

/**
 * A typed error so the retry logic can branch on failure kind.
 * kind: 'auth' | 'transient' | 'credentials' | 'fatal'
 */
class GlookoError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Encapsulates the multi-step Glooko authentication flow.
 * Returns { fetch, patientId, urls }. Throws GlookoError on failure.
 */
async function performLogin(email, password) {
  let loginPageRes;
  try {
    loginPageRes = await fetchWithCookieJar(email, password);
  } catch (err) {
    throw err;
  }
  return loginPageRes;
}

async function fetchWithCookieJar(email, password) {
  const jar = new CookieJar();
  const fetch = makeFetchCookie(originalFetch, jar);

  let loginPageRes;
  try {
    loginPageRes = await fetch(
      `${BASE_DOMAIN}/users/sign_in?id=login_form&locale=en-GB`,
      { redirect: 'manual' }
    );
  } catch (err) {
    // Network-level failure reaching the login page is transient.
    throw new GlookoError('transient', `Login page unreachable: ${err.message}`);
  }

  const regionalLoginUrl =
    loginPageRes.headers.get('location') || `${BASE_DOMAIN}/users/sign_in`;

  let authenticityToken;
  try {
    const regionalPage = await fetch(regionalLoginUrl);
    const htmlContent = await regionalPage.text();
    const tokenMatch = htmlContent.match(/name="csrf-token" content="([^"]+)"/);
    authenticityToken = tokenMatch ? tokenMatch[1] : null;
  } catch (err) {
    throw new GlookoError('transient', `Login token fetch failed: ${err.message}`);
  }

  if (!authenticityToken) {
    // Markup changed or page didn't load as expected. Treat as auth-flow
    // failure rather than transient, since retrying the same way won't help.
    throw new GlookoError('auth', 'SECURITY_TOKEN_MISSING');
  }

  const loginParams = new URLSearchParams({
    authenticity_token: authenticityToken,
    'user[email]': email,
    'user[password]': password,
    commit: 'Log In',
  });

  let authResponse, dashboardHtml;
  try {
    authResponse = await fetch(regionalLoginUrl, {
      method: 'POST',
      body: loginParams,
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        Referer: regionalLoginUrl,
      },
    });
    dashboardHtml = await authResponse.text();
  } catch (err) {
    throw new GlookoError('transient', `Login POST failed: ${err.message}`);
  }

  const patientMatch = dashboardHtml.match(/window\.patient\s*=\s*"([^"]+)"/);
  if (!patientMatch) {
    // Login submitted but no patient context came back: wrong credentials.
    throw new GlookoError('credentials', 'CREDENTIAL_MISMATCH');
  }

  const apiMatch = dashboardHtml.match(/apiUrl:\s*'([^']+)'/);
  const scrapedApiUrl = apiMatch ? apiMatch[1] : null;
  let apiBase;

  if (scrapedApiUrl) {
    apiBase = scrapedApiUrl;
  } else {
    const urlObj = new URL(authResponse.url);
    apiBase = `${urlObj.protocol}//${urlObj.hostname.replace(
      'my.glooko',
      'api.glooko'
    )}`;
  }

  return {
    fetch,
    patientId: patientMatch[1],
    urls: {
      data: `${apiBase}/api/v3/graph/data`,
      stats: `${apiBase}/api/v3/graph/statistics/overall`,
      settings: `${apiBase}/api/v3/devices_and_settings`,
    },
  };
}

/**
 * Performs the three parallel Glooko calls for a date range.
 * Throws GlookoError('auth') on 401, GlookoError('transient') on other
 * non-ok responses or network errors.
 */
async function executeFetch(currentSession, startDate, endDate) {
  const { fetch, patientId, urls } = currentSession;
  const queryString =
    `patient=${patientId}&startDate=${startDate}&endDate=${endDate}` +
    `&locale=en-GB&insulinTooltips=true&filterBgReadings=true&splitByDay=false`;
  // Omnipod 5 and Tandem (Control-IQ, via Tandem Source) series. Glooko only
  // returns data for the ones the account's devices populate.
  const seriesString = GRAPH_SERIES.map((s) => `&series[]=${s}`).join('');

  const url1 = `${urls.data}?${queryString}${seriesString}`;
  const url2 =
    `${urls.stats}?patient=${patientId}&startDate=${startDate}&endDate=${endDate}` +
    `&egv=false&includeInsulin=true&includeExercise=true` +
    `&dow=monday,tuesday,wednesday,thursday,friday,saturday,sunday&includePumpModes=true`;
  const url3 = `${urls.settings}?patient=${patientId}`;

  const requestHeaders = {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };

  let r1, r2, r3;
  try {
    [r1, r2, r3] = await Promise.all([
      fetch(url1, { headers: requestHeaders }),
      fetch(url2, { headers: requestHeaders }),
      fetch(url3, { headers: requestHeaders }),
    ]);
  } catch (err) {
    throw new GlookoError('transient', `Network error during fetch: ${err.message}`);
  }

  if ([r1.status, r2.status, r3.status].includes(401)) {
    throw new GlookoError('auth', 'UNAUTHORIZED');
  }
  if (!r1.ok || !r2.ok || !r3.ok) {
    const codes = [r1.status, r2.status, r3.status].join(',');
    throw new GlookoError('transient', `API returned non-ok status (${codes})`);
  }

  let data1, data2, data3;
  try {
    [data1, data2, data3] = await Promise.all([
      r1.json(),
      r2.json(),
      r3.json(),
    ]);
  } catch (err) {
    throw new GlookoError('transient', `Malformed JSON response: ${err.message}`);
  }
  return { startDate, endDate, data1, data2, data3 };
}

/**
 * Public entry point. Fetches a raw Glooko range as a single pull, handling:
 *   - session reuse,
 *   - up to MAX_TRANSIENT_RETRIES transient retries with backoff (no re-login),
 *   - up to MAX_RELOGIN_ATTEMPTS re-logins on auth failure,
 *   - immediate terminal failure on bad credentials.
 */
export async function fetchGlookoRange(startDate, endDate) {
  // Test seam: when a stub is installed (only ever set by the test harness),
  // use it instead of touching the network. Inert in production.
  if (typeof globalThis.__OMNI_FETCH_STUB__ === 'function') {
    return globalThis.__OMNI_FETCH_STUB__(startDate, endDate);
  }

  const { email, password } = getCredentials();

  let reloginsUsed = 0;
  let transientAttempt = 0;

  // Ensure we have a session to start with.
  if (!session) {
    session = await loginWithReloginCap(email, password, () => reloginsUsed++, () => reloginsUsed);
  }

  while (true) {
    try {
      return await executeFetch(session, startDate, endDate);
    } catch (err) {
      const kind = err instanceof GlookoError ? err.kind : 'transient';

      if (kind === 'credentials') {
        throw new Error(
          'Invalid Glooko credentials. Check GLOOKO_EMAIL and GLOOKO_PASSWORD.'
        );
      }

      if (kind === 'auth') {
        // Session is dead. Re-login once (strict cap), then retry the fetch.
        if (reloginsUsed >= MAX_RELOGIN_ATTEMPTS) {
          throw new Error(
            'Glooko authentication failed after re-login. The session could not ' +
              'be re-established. Check credentials or try again later.'
          );
        }
        session = null;
        reloginsUsed++;
        session = await freshLogin(email, password);
        // Loop and retry the fetch on the new session. Reset transient counter,
        // since this is effectively a fresh start on a good session.
        transientAttempt = 0;
        continue;
      }

      // transient
      transientAttempt++;
      if (transientAttempt > MAX_TRANSIENT_RETRIES) {
        // Exhausted transient retries. As a last resort, the failure MIGHT be a
        // silently-expired session presenting as a transient error: allow the
        // one re-login if we have not used it yet.
        if (reloginsUsed < MAX_RELOGIN_ATTEMPTS) {
          session = null;
          reloginsUsed++;
          session = await freshLogin(email, password);
          transientAttempt = 0;
          continue;
        }
        throw new Error(
          `Glooko request failed after ${MAX_TRANSIENT_RETRIES} retries: ${err.message}`
        );
      }
      // Exponential-ish backoff: 1.5s, 3s, 4.5s, 6s, 7.5s
      await sleep(RETRY_BASE_DELAY_MS * transientAttempt);
    }
  }
}

async function freshLogin(email, password) {
  try {
    return await fetchWithCookieJar(email, password);
  } catch (err) {
    if (err instanceof GlookoError && err.kind === 'credentials') {
      throw new Error(
        'Invalid Glooko credentials. Check GLOOKO_EMAIL and GLOOKO_PASSWORD.'
      );
    }
    throw new Error(`Glooko login failed: ${err.message}`);
  }
}

async function loginWithReloginCap(email, password) {
  return freshLogin(email, password);
}

// Exposed for tests: reset the module session.
export function _resetSession() {
  session = null;
}
