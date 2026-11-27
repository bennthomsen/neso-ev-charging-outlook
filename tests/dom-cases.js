import { REFRESH_MS, buildOutlook } from "../neso-ev-charging-outlook.js";
import { fixture, FIXTURE_NOW } from "./fixture.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, message) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await settle();
  }
}

export async function runDomTests(report = () => {}) {
  const nativeFetch = window.fetch;
  const nativeNow = Date.now;
  const nativeInterval = window.setInterval;
  const nativeClearInterval = window.clearInterval;
  const intervals = new Map();
  const results = [];
  let now = FIXTURE_NOW;
  let calls = 0;
  let scenario = "normal";
  let aborted = false;
  let nextTimer = 100000;
  let card;
  const host = document.createElement("div");
  host.style.cssText = "width:320px;max-width:100%;";
  document.body.append(host);
  Date.now = () => now;
  window.setInterval = (callback, ms) => {
    const id = nextTimer++;
    intervals.set(id, { callback, ms });
    return id;
  };
  window.clearInterval = (id) => intervals.delete(id);
  window.fetch = async (_url, { signal }) => {
    calls++;
    if (scenario === "network") throw new TypeError("Test network error");
    if (scenario === "pending") return new Promise((resolve, reject) => {
      const abort = () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    const payload = fixture({ now, averages: scenario === "identical" ? [8000] : undefined,
      issue: scenario === "stale" ? now - 7 * 3600000 : now });
    if (scenario === "missing") {
      payload.result.records.shift();
      payload.result.total--;
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const test = async (name, run) => {
    try {
      await run();
      results.push({ name, passed: true });
      report(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
      report(`FAIL ${name}: ${error.message}`);
    }
  };
  const root = () => card.shadowRoot;
  const refresh = async (value) => {
    scenario = value;
    root().querySelector("button").click();
    await waitFor(() => !root().querySelector("button").disabled, "Refresh did not finish");
  };
  try {
    await test("Card picker and editor are registered without Home Assistant internals", async () => {
      assert(window.customCards.some((item) => item.type === "neso-ev-charging-outlook"), "Picker registration missing");
      card = document.createElement("neso-ev-charging-outlook");
      card.setConfig({ type: "custom:neso-ev-charging-outlook" });
      host.append(card);
      await waitFor(() => !root().querySelector("button").disabled, "Initial fetch did not finish");
      assert(root().querySelectorAll("tbody tr").length === 14, "Expected 14 rows");
      assert(root().querySelectorAll(".number").length === 14, "Expected 14 valid scores");
      assert(root().querySelectorAll(".candidate").length === 3, "Expected three candidates");
      assert(root().querySelector(".number").textContent === String(buildOutlook(fixture(), now).nights[0].score), "Incorrect displayed score");
    });
    await test("Hass updates and configuration changes never trigger network fetches", async () => {
      const count = calls;
      for (let i = 0; i < 10; i++) card.hass = { states: {} };
      card.setConfig({ type: "custom:neso-ev-charging-outlook", title: '<img src=x onerror="throw 1">' });
      await settle();
      assert(calls === count, "Hass or config caused a fetch");
      assert(!root().querySelector("img"), "Title was interpreted as HTML");
      assert(root().querySelector("h2").textContent.startsWith("<img"), "Title was not rendered as text");
      card.setConfig({ type: "custom:neso-ev-charging-outlook" });
    });
    await test("Relative bars, dates and narrow layout match the forecast without horizontal overflow", () => {
      const fills = [...root().querySelectorAll(".fill")];
      assert(fills.some((fill) => fill.style.width === "100%" && fill.classList.contains("green")), "Highest score is not a full green bar");
      assert(fills.some((fill) => fill.style.width === "0%" && fill.classList.contains("red")), "Lowest score is not zero/red");
      assert(root().querySelector("tbody th").textContent.includes("28 Nov"), "First row should be tomorrow");
      assert(root().querySelectorAll(".range").length === 7, "Long-range annotation missing");
      assert(root().querySelector("ha-card").scrollWidth <= Math.ceil(card.getBoundingClientRect().width), "Card overflows at 320px");
    });
    await test("Identical averages show score 50 and an explicit no-preference message", async () => {
      await refresh("identical");
      assert(root().querySelector(".summary").textContent.includes("No preference"), "No preference message missing");
      assert(root().querySelectorAll(".candidate").length === 0, "Equal forecasts should not recommend candidates");
      assert([...root().querySelectorAll(".number")].every((node) => node.textContent === "50"), "Equal wind did not score 50");
    });
    await test("Incomplete nights show no signal and never masquerade as zero wind", async () => {
      await refresh("missing");
      assert(root().querySelectorAll(".number").length === 13, "Other valid nights were lost");
      const row = root().querySelector("tbody tr");
      assert(row.querySelector("td").textContent === "—", "Missing wind should not be displayed as zero");
      assert(row.textContent.includes("No signal"), "Missing night needs no-signal text");
      assert(row.lastChild.getAttribute("aria-label").includes("Incomplete"), "Missing reason is inaccessible");
    });
    await test("A failed refresh removes previous recommendations and shows a visible error", async () => {
      await refresh("network");
      assert(root().querySelector(".status").textContent.includes("Cannot reach NESO"), "Network error is not visible");
      assert(root().querySelectorAll(".candidate, .number").length === 0, "Failed refresh kept recommendations");
      assert(!root().querySelector("button").disabled, "Refresh remained disabled after an error");
    });
    await test("Stale forecasts are not recommended, and a successful retry recovers", async () => {
      await refresh("stale");
      assert(root().querySelector(".status").textContent.includes("6 hours"), "Stale warning missing");
      assert(root().querySelectorAll(".number").length === 0, "Stale scores are still shown");
      await refresh("normal");
      assert(root().querySelectorAll(".number").length === 14, "Successful retry did not recover");
    });
    await test("The clock moves tomorrow-only windows and expires scores without another fetch", () => {
      const clock = [...intervals.values()].find((timer) => timer.ms === 60000);
      const count = calls;
      now = FIXTURE_NOW + 4 * 3600000;
      clock.callback();
      assert(root().querySelector("tbody th").textContent.includes("29 Nov"), "Midnight rollover was not applied");
      now = FIXTURE_NOW + 6 * 3600000 + 1;
      clock.callback();
      assert(root().querySelectorAll(".number, .candidate").length === 0, "Clock expiry left stale recommendations");
      assert(root().querySelector(".status").textContent.includes("6 hours"), "Clock expiry did not warn");
      assert(calls === count, "Clock render triggered a fetch");
      now = FIXTURE_NOW;
    });
    await test("Polling is every 30 minutes and overlap does not cause extra requests", async () => {
      const poll = [...intervals.values()].find((timer) => timer.ms === REFRESH_MS);
      assert(poll, "30-minute poll timer missing");
      scenario = "pending";
      const count = calls;
      poll.callback();
      poll.callback();
      await settle();
      assert(calls === count + 1, "Overlapping polls caused multiple requests");
      assert(root().querySelector("button").disabled, "Refresh is not disabled while loading");
    });
    await test("Removing the card aborts in-flight fetches and clears both timers; reconnect works", async () => {
      card.remove();
      await settle();
      assert(aborted, "Pending request was not aborted");
      assert(intervals.size === 0, "Timers leaked after disconnect");
      scenario = "normal";
      host.append(card);
      await waitFor(() => !root().querySelector("button").disabled, "Reconnect fetch did not finish");
      assert(root().querySelectorAll(".number").length === 14, "Reconnect did not fetch a fresh forecast");
      assert(intervals.size === 2, "Reconnect did not create exactly two timers");
    });
    await test("The visual editor emits a composed config-changed event with title only", () => {
      const editor = card.constructor.getConfigElement();
      editor.setConfig({ type: "custom:neso-ev-charging-outlook", title: "Original" });
      let event;
      editor.addEventListener("config-changed", (value) => { event = value; });
      const input = editor.shadowRoot.querySelector("input");
      input.value = "Custom wind outlook";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      assert(event?.bubbles && event.composed, "Config event must reach HA");
      assert(event.detail.config.title === "Custom wind outlook", "Editor title not updated");
      assert(event.detail.config.type === "custom:neso-ev-charging-outlook", "Editor dropped the card type");
    });
  } finally {
    host.remove();
    window.fetch = nativeFetch;
    Date.now = nativeNow;
    window.setInterval = nativeInterval;
    window.clearInterval = nativeClearInterval;
  }
  return results;
}
