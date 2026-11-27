import {
  NESO_ENDPOINT, REFRESH_MS, parseUtcTimestamp, nightWindow, upcomingNights, scoreColor,
  rankNights, validateDataset, buildOutlook, fetchForecast,
} from "../neso-ev-charging-outlook.js";
import { fixture, FIXTURE_NOW } from "./fixture.js";

function assert(condition, message = "Assertion failed") {
  if (!condition) throw new Error(message);
}
function equal(actual, expected) {
  assert(Object.is(actual, expected), `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function throws(callback, code) {
  try { callback(); } catch (error) { equal(error.code, code); return; }
  throw new Error(`Expected error: ${code}`);
}
async function rejects(callback, code) {
  try { await callback(); } catch (error) { equal(error.code, code); return; }
  throw new Error(`Expected rejection: ${code}`);
}
function resize(payload) {
  payload.result.total = payload.result.records.length;
  return payload;
}

export async function runTests(report = () => {}) {
  const tests = [];
  const test = (name, run) => tests.push({ name, run });

  test("UTC parsing is independent of browser timezone; invalid dates are rejected", () => {
    equal(parseUtcTimestamp("2026-11-27T21:00:00"), Date.parse("2026-11-27T21:00:00Z"));
    equal(parseUtcTimestamp("2026-11-27T21:00:00.12Z"), Date.parse("2026-11-27T21:00:00.120Z"));
    for (const invalid of [null, "", "2026-02-30T00:00:00", "2026-11-27T24:00:00", "2026-13-01T00:00:00"]) {
      assert(Number.isNaN(parseUtcTimestamp(invalid)));
    }
  });
  test("London DST windows contain 10, 12 or 14 half-hours", () => {
    equal(nightWindow("2027-03-28").slots.length, 10);
    equal(nightWindow("2027-10-31").slots.length, 14);
    equal(nightWindow("2027-06-01").slots.length, 12);
    equal(nightWindow("2027-03-28").end, Date.parse("2027-03-28T05:00:00Z"));
    equal(nightWindow("2027-10-31").start, Date.parse("2027-10-30T23:00:00Z"));
    equal(nightWindow("2027-10-31").end, Date.parse("2027-10-31T06:00:00Z"));
  });
  test("Outlook starts tomorrow in London, including UTC date rollover", () => {
    const nights = upcomingNights(Date.parse("2027-06-01T23:30:00Z"));
    equal(nights[0].date, "2027-06-03");
    equal(nights[13].date, "2027-06-16");
    equal(nights.length, 14);
  });
  test("Score formula preserves tiny spreads, zero wind and correct thresholds", () => {
    const result = rankNights([
      { date: "a", averageMw: 0 }, { date: "b", averageMw: 0.000001 }, { date: "c", averageMw: null },
    ]);
    equal(result.nights[0].score, 0);
    equal(result.nights[1].score, 100);
    equal(result.nights[2].score, null);
    equal(result.candidates[0].date, "b");
    equal(scoreColor(67), "green"); equal(scoreColor(66), "amber");
    equal(scoreColor(34), "amber"); equal(scoreColor(33), "red");
    equal(scoreColor(null), "missing");
    const middle = rankNights([{ averageMw: 100 }, { averageMw: 101 }, { averageMw: 103 }]);
    equal(middle.nights[1].score, 33);
  });
  test("Identical averages, including zero and only one valid night, give no preference", () => {
    for (const averages of [[0, 0], [12, 12], [12]]) {
      const result = rankNights(averages.map((averageMw) => ({ averageMw })));
      assert(result.noPreference);
      assert(result.nights.every((night) => night.score === 50));
      equal(result.candidates.length, 0);
    }
    equal(rankNights([{ averageMw: null }]).validCount, 0);
  });
  test("Complete forecast yields 14 averages and relative strongest candidates", () => {
    const outlook = buildOutlook(fixture(), FIXTURE_NOW);
    equal(outlook.validCount, 14);
    equal(outlook.nights[0].averageMw, 8200);
    equal(outlook.candidates[0].averageMw, 19400);
    equal(outlook.candidates[0].score, 100);
    equal(Math.min(...outlook.nights.map((night) => night.score)), 0);
    equal(outlook.nights[6].longRange, false);
    equal(outlook.nights[7].longRange, true);
  });
  test("Half-hour averages use actual DST coverage and exclude 06:00", () => {
    for (const now of [Date.parse("2027-03-27T12:00:00Z"), Date.parse("2027-10-30T12:00:00Z")]) {
      const payload = fixture({ now, averages: [1000] });
      const night = upcomingNights(now)[0];
      const rows = payload.result.records.filter((row) => night.slots.includes(parseUtcTimestamp(row.Datetime)));
      rows[0].Wind_Forecast = 2000;
      payload.result.records.push({ ...rows[0], _id: 9999, Datetime: new Date(night.end).toISOString(), Wind_Forecast: 29000 });
      resize(payload);
      const outlook = buildOutlook(payload, now);
      assert(Math.abs(outlook.nights[0].averageMw - (1000 + 1000 / night.slots.length)) < 1e-9);
    }
  });
  test("Missing and duplicate samples invalidate only their own night", () => {
    const missing = fixture();
    missing.result.records.shift();
    const outlook = buildOutlook(resize(missing), FIXTURE_NOW);
    equal(outlook.validCount, 13);
    equal(outlook.nights[0].score, null);
    equal(outlook.nights[0].averageMw, null);
    equal(outlook.nights[0].reason, "Incomplete forecast coverage");
    const duplicate = fixture();
    duplicate.result.records.push({ ...duplicate.result.records[0], _id: 9999 });
    const dup = buildOutlook(resize(duplicate), FIXTURE_NOW);
    equal(dup.validCount, 13);
    equal(dup.nights[0].reason, "Duplicate half-hour samples");
  });
  test("Off-grid half-hours do not silently produce recommendations", () => {
    const payload = fixture();
    payload.result.records[0].Datetime = payload.result.records[0].Datetime.replace("00:00:00", "00:15:00");
    const outlook = buildOutlook(payload, FIXTURE_NOW);
    equal(outlook.nights[0].score, null);
    equal(outlook.nights[0].reason, "Unexpected sample time");
  });
  test("Invalid wind/capacity cannot become zero; actual zero is valid", () => {
    for (const value of [-1, null, "", "NaN", Infinity, 30001, true]) {
      const payload = fixture();
      payload.result.records[0].Wind_Forecast = value;
      equal(buildOutlook(payload, FIXTURE_NOW).nights[0].score, null);
    }
    for (const value of [0, -1, null, "", Infinity]) {
      const payload = fixture();
      payload.result.records[0].Capacity = value;
      equal(buildOutlook(payload, FIXTURE_NOW).nights[0].score, null);
    }
    const payload = fixture({ averages: [0, 1000] });
    equal(buildOutlook(payload, FIXTURE_NOW).nights[0].score, 0);
    payload.result.records[0].Wind_Forecast = "0";
    equal(buildOutlook(payload, FIXTURE_NOW).nights[0].score, 0);
  });
  test("Latest forecast issue is used without mixing older coverage", () => {
    const payload = fixture();
    const old = { ...payload.result.records[0], _id: 9999, Wind_Forecast: 29000,
      ForecastDateTime: new Date(FIXTURE_NOW - 3600000).toISOString() };
    payload.result.records.push(old);
    equal(buildOutlook(resize(payload), FIXTURE_NOW).validCount, 14);
    payload.result.records.shift();
    equal(buildOutlook(resize(payload), FIXTURE_NOW).nights[0].score, null);
  });
  test("Stale and implausibly future forecasts fail closed at exact boundaries", () => {
    const payload = fixture();
    buildOutlook(payload, FIXTURE_NOW + 6 * 3600000);
    throws(() => buildOutlook(payload, FIXTURE_NOW + 6 * 3600000 + 1), "stale");
    buildOutlook(fixture({ issue: FIXTURE_NOW + 15 * 60000 }), FIXTURE_NOW);
    throws(() => buildOutlook(fixture({ issue: FIXTURE_NOW + 15 * 60000 + 1000 }), FIXTURE_NOW), "future");
    payload.result.records[0].ForecastDateTime = "bad";
    throws(() => buildOutlook(payload, FIXTURE_NOW), "timestamp");
  });
  test("Truncated, empty, API-error and malformed datasets are rejected", () => {
    const payload = fixture();
    payload.result.total++;
    throws(() => buildOutlook(payload, FIXTURE_NOW), "incomplete");
    for (const total of ["168", -1, 1.5, null]) {
      throws(() => validateDataset({ success: true, result: { records: [], total } }), "incomplete");
    }
    throws(() => validateDataset({ success: true, result: { records: [], total: 0 } }), "incomplete");
    throws(() => validateDataset({ success: false }), "api");
    throws(() => validateDataset({ success: true, result: {} }), "api");
    const bad = fixture();
    bad.result.records[0].Datetime = "bad";
    throws(() => buildOutlook(bad, FIXTURE_NOW), "timestamp");
  });
  test("Fetch uses the exact public endpoint, _id field, CORS and no credentials", async () => {
    const payload = fixture();
    let calls = 0;
    const result = await fetchForecast({ fetchImpl: async (url, options) => {
      calls++;
      equal(url, NESO_ENDPOINT);
      const query = new URL(url).searchParams;
      equal(query.get("resource_id"), "93c3048e-1dab-4057-a2a9-417540583929");
      assert(query.get("fields").split(",").includes("_id"));
      equal(query.get("limit"), "1000");
      equal(options.credentials, "omit"); equal(options.mode, "cors"); equal(options.cache, "no-store");
      return { ok: true, json: async () => payload };
    } });
    equal(calls, 1); equal(result, payload);
    equal(REFRESH_MS, 1800000);
  });
  test("HTTP, network, JSON, API and truncated fetch failures are explicit", async () => {
    await rejects(() => fetchForecast({ fetchImpl: async () => ({ ok: false, status: 503 }) }), "http");
    await rejects(() => fetchForecast({ fetchImpl: async () => { throw new TypeError("network"); } }), "network");
    await rejects(() => fetchForecast({ fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }) }), "json");
    await rejects(() => fetchForecast({ fetchImpl: async () => ({ ok: true, json: async () => ({ success: false }) }) }), "api");
    const payload = fixture(); payload.result.total++;
    await rejects(() => fetchForecast({ fetchImpl: async () => ({ ok: true, json: async () => payload }) }), "incomplete");
  });
  test("Timeout and external cancellation abort requests", async () => {
    const waitingFetch = (_, { signal }) => new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    await rejects(() => fetchForecast({ fetchImpl: waitingFetch, timeoutMs: 5 }), "timeout");
    const controller = new AbortController();
    const pending = fetchForecast({ fetchImpl: waitingFetch, signal: controller.signal });
    controller.abort();
    try { await pending; throw new Error("Expected cancellation"); } catch (error) { equal(error.name, "AbortError"); }
    await rejects(() => fetchForecast({ fetchImpl: async () => {
      return { ok: true, json: async () => ({ success: false }) };
    } }), "api");
  });

  const results = [];
  for (const { name, run } of tests) {
    try {
      await run();
      results.push({ name, passed: true });
      report(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
      report(`FAIL ${name}: ${error.message}`);
    }
  }
  return results;
}
