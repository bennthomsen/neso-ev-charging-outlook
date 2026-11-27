export const NESO_ENDPOINT =
  "https://api.neso.energy/api/3/action/datastore_search?resource_id=93c3048e-1dab-4057-a2a9-417540583929&limit=1000&fields=_id,Datetime,Wind_Forecast,ForecastDateTime,Capacity";
export const SOURCE_URL = "https://www.neso.energy/data-portal/14-days-ahead-wind-forecasts";
export const DATA_LICENCE_URL = "https://www.neso.energy/data-portal/ngeso-open-licence";
export const REFRESH_MS = 30 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 15 * 60 * 1000;
const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const dateLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short",
});
const issueLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", day: "numeric", month: "short",
  hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

export class ForecastError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ForecastError";
    this.code = code;
  }
}

export function parseUtcTimestamp(value) {
  if (typeof value !== "string") return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, s] = parts;
  const timestamp = Date.UTC(y, m - 1, d, h, min, s, Number(fraction.padEnd(3, "0")));
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 ||
      date.getUTCDate() !== d || date.getUTCHours() !== h ||
      date.getUTCMinutes() !== min || date.getUTCSeconds() !== s) return NaN;
  return timestamp;
}

function partsAt(timestamp) {
  return Object.fromEntries(londonParts.formatToParts(timestamp)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

function dateKey(timestamp) {
  const { year, month, day } = partsAt(timestamp);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date, days) {
  const timestamp = parseUtcTimestamp(`${date}T00:00:00Z`) + days * 86400000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function londonHour(date, hour) {
  const target = parseUtcTimestamp(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  let candidate = target;
  // Resolve wall time at both ends, since the UTC offset can change within a night.
  for (let i = 0; i < 3; i++) {
    const p = partsAt(candidate);
    const wallTime = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    candidate += target - wallTime;
  }
  return candidate;
}

export function nightWindow(date) {
  const start = londonHour(date, 0);
  const end = londonHour(date, 6);
  const slots = [];
  for (let timestamp = start; timestamp < end; timestamp += HALF_HOUR_MS) slots.push(timestamp);
  return { start, end, slots };
}

export function upcomingNights(now = Date.now()) {
  const today = dateKey(now);
  return Array.from({ length: 14 }, (_, index) => {
    const date = addDays(today, index + 1);
    const window = nightWindow(date);
    return {
      date, label: dateLabel.format(window.start), ...window,
      longRange: index >= 7, averageMw: null, score: null,
      reason: "No forecast available",
    };
  });
}

export function scoreColor(score) {
  if (score === null) return "missing";
  return score >= 67 ? "green" : score > 33 ? "amber" : "red";
}

export function rankNights(nights) {
  const valid = nights.filter((night) => Number.isFinite(night.averageMw) && night.averageMw >= 0);
  const low = valid.length ? Math.min(...valid.map((night) => night.averageMw)) : null;
  const high = valid.length ? Math.max(...valid.map((night) => night.averageMw)) : null;
  const noPreference = valid.length > 0 && high === low;
  const ranked = nights.map((night) => {
    const usable = Number.isFinite(night.averageMw) && night.averageMw >= 0;
    const score = !usable ? null : noPreference ? 50 :
      Math.round(100 * ((night.averageMw - low) / (high - low)));
    return { ...night, averageMw: usable ? night.averageMw : null, score, color: scoreColor(score) };
  });
  const candidates = noPreference ? [] : ranked.filter((night) => night.score !== null)
    .sort((a, b) => b.averageMw - a.averageMw || a.date.localeCompare(b.date)).slice(0, 3);
  return { nights: ranked, candidates, noPreference, validCount: valid.length, low, high };
}

function numberValue(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return NaN;
  return Number(value);
}

export function validateDataset(payload) {
  if (payload?.success !== true || !payload.result || !Array.isArray(payload.result.records)) {
    throw new ForecastError("api", "NESO did not return a successful forecast dataset.");
  }
  const { records, total } = payload.result;
  if (!Number.isSafeInteger(total) || total < 1 || records.length !== total) {
    throw new ForecastError("incomplete", "The NESO dataset is empty or incomplete. No recommendations are shown.");
  }
  return records;
}

export function buildOutlook(payload, now = Date.now()) {
  const records = validateDataset(payload);
  let issue = -Infinity;
  const parsed = records.map((record) => {
    const time = parseUtcTimestamp(record?.Datetime);
    const issued = parseUtcTimestamp(record?.ForecastDateTime);
    if (!Number.isFinite(time) || !Number.isFinite(issued)) {
      throw new ForecastError("timestamp", "NESO returned an invalid forecast timestamp. No recommendations are shown.");
    }
    issue = Math.max(issue, issued);
    return {
      time, issued, wind: numberValue(record.Wind_Forecast), capacity: numberValue(record.Capacity),
    };
  });
  if (now - issue > MAX_AGE_MS) {
    throw new ForecastError("stale", "The NESO forecast is more than 6 hours old. No recommendations are shown.");
  }
  if (issue - now > MAX_FUTURE_MS) {
    throw new ForecastError("future", "The NESO forecast issue is over 15 minutes in the future. Check your device clock.");
  }
  const current = new Map();
  for (const record of parsed) {
    if (record.issued !== issue) continue;
    const rows = current.get(record.time) ?? [];
    rows.push(record);
    current.set(record.time, rows);
  }
  const nights = upcomingNights(now).map((night) => {
    const rows = night.slots.map((slot) => current.get(slot) ?? []);
    const offGrid = parsed.some((row) => row.issued === issue &&
      row.time >= night.start && row.time < night.end && !night.slots.includes(row.time));
    if (offGrid) return { ...night, reason: "Unexpected sample time" };
    if (rows.some((samples) => samples.length > 1)) return { ...night, reason: "Duplicate half-hour samples" };
    if (rows.some((samples) => samples.length === 0)) return { ...night, reason: "Incomplete forecast coverage" };
    const samples = rows.map(([row]) => row);
    if (samples.some((row) => !Number.isFinite(row.wind) || row.wind < 0 ||
        !Number.isFinite(row.capacity) || row.capacity <= 0 || row.wind > row.capacity)) {
      return { ...night, reason: "Invalid wind or capacity data" };
    }
    const averageMw = samples.reduce((mean, row, index) => mean + (row.wind - mean) / (index + 1), 0);
    return { ...night, averageMw, reason: null };
  });
  return { ...rankNights(nights), issue };
}

export async function fetchForecast({ fetchImpl = globalThis.fetch, signal, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const relay = () => controller.abort(signal.reason);
  if (signal?.aborted) relay();
  else signal?.addEventListener("abort", relay, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(NESO_ENDPOINT, {
      signal: controller.signal, credentials: "omit", mode: "cors", cache: "no-store",
    });
    if (!response.ok) throw new ForecastError("http", `NESO request failed (HTTP ${response.status}).`);
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new ForecastError("json", "NESO returned an unreadable JSON response.");
    }
    validateDataset(payload);
    return payload;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) throw new ForecastError("timeout", "The NESO request timed out. Try refreshing.");
    if (error instanceof ForecastError) throw error;
    throw new ForecastError("network", "Cannot reach NESO. Check your internet connection and browser access.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

const styles = `
  :host { display:block; --wind-green:#18824b; --wind-amber:#a66a00; --wind-red:#bd3939;
    color:var(--primary-text-color,#202b36); font-family:var(--paper-font-body1_-_font-family,system-ui,sans-serif); }
  * { box-sizing:border-box; }
  ha-card { display:block; padding:22px; background:var(--ha-card-background,var(--card-background-color,#fff));
    border:1px solid var(--ha-card-border-color,var(--divider-color,#dce2e8));
    border-radius:var(--ha-card-border-radius,16px); box-shadow:var(--ha-card-box-shadow,none); }
  header { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; }
  h2 { margin:0; font-size:21px; font-weight:600; line-height:1.3; }
  p { margin:8px 0; font-size:13px; line-height:1.5; }
  .muted { color:var(--secondary-text-color,#526170); }
  button { flex-shrink:0; border:1px solid var(--divider-color,#dce2e8); border-radius:8px;
    padding:8px 10px; color:var(--primary-text-color,#202b36); background:transparent;
    cursor:pointer; font:inherit; font-size:12px; min-height:36px; }
  button:focus-visible, a:focus-visible { outline:2px solid var(--primary-color,#037ba2); outline-offset:3px; }
  button:disabled { opacity:.6; cursor:wait; }
  .status { padding:10px 12px; border-radius:8px; background:var(--secondary-background-color,#f2f5f8); }
  .status.warning { border-left:4px solid var(--wind-amber); }
  .best { margin:16px 0; padding:14px; border:1px solid var(--divider-color,#dce2e8); border-radius:10px; }
  .best h3 { margin:0 0 6px; font-size:14px; }
  .candidates { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .candidate { padding:7px 9px; border-radius:7px; background:var(--secondary-background-color,#f2f5f8);
    font-size:12px; line-height:1.5; }
  .candidate strong { display:block; }
  .table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:13px; }
  th { font-weight:500; font-size:11px; color:var(--secondary-text-color,#526170); text-align:left; padding:0 0 9px; }
  th:first-child { width:34%; } th:nth-child(2) { width:18%; text-align:right; padding-right:12px; }
  td { padding:8px 0; border-top:1px solid var(--divider-color,#e4e8ed); vertical-align:middle; }
  tbody th { padding:8px 0; border-top:1px solid var(--divider-color,#e4e8ed);
    color:var(--primary-text-color,#202b36); font-size:13px; }
  td:nth-child(2) { text-align:right; padding-right:12px; font-variant-numeric:tabular-nums; }
  .date { font-weight:500; }
  .range { display:block; font-size:10px; color:var(--secondary-text-color,#526170); margin-top:2px; }
  .score { display:flex; align-items:center; gap:9px; }
  .track { flex:1; height:9px; border-radius:5px; background:var(--secondary-background-color,#eaf0f4); overflow:hidden; }
  .fill { height:100%; border-radius:5px; }
  .green { background:var(--wind-green); } .amber { background:var(--wind-amber); } .red { background:var(--wind-red); }
  .number { min-width:28px; text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
  .missing { font-size:11px; color:var(--secondary-text-color,#526170); }
  .legend { display:flex; flex-wrap:wrap; gap:12px; margin-top:14px; font-size:11px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; }
  footer { margin-top:16px; border-top:1px solid var(--divider-color,#e4e8ed); padding-top:10px; }
  footer p { font-size:11px; }
  a { color:var(--primary-color,#006d91); }
  @media(max-width:380px) { ha-card { padding:14px; } h2 { font-size:18px; }
    th:first-child { width:35%; } th:nth-child(2) { width:20%; } .score { gap:5px; } }
`;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

if (typeof customElements !== "undefined" && typeof HTMLElement !== "undefined") {
  class NesoEvChargingOutlook extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._config = { type: "custom:neso-ev-charging-outlook" };
      this._payload = null;
      this._error = null;
      this._loading = false;
      this.shadowRoot.innerHTML = `<style>${styles}</style><ha-card>
        <header><h2></h2><button type="button" aria-label="Refresh NESO forecast">Refresh</button></header>
        <p class="muted">Next 14 nights · 00:00–06:00 Europe/London</p>
        <p class="status" role="status" aria-live="polite"></p>
        <section class="best"><h3>Strongest wind candidates</h3><p class="summary"></p><div class="candidates"></div></section>
        <table class="table" aria-label="Nightly national wind forecast and relative charging score">
          <thead><tr><th scope="col">Night ending 06:00</th><th scope="col">Wind GW</th><th scope="col">Score / 100</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="legend"><span><i class="dot green"></i>67–100 higher</span><span><i class="dot amber"></i>34–66 middle</span>
          <span><i class="dot red"></i>0–33 lower</span></div>
        <footer><p>Wind-based advisory, not a tariff forecast. Higher scores and longer bars mean more forecast wind,
          relative to this snapshot. Missing nights are not ranked.</p>
          <p>Longer-range forecasts (nights 8–14) are more uncertain. Demand, fuel prices, outages,
          interconnectors and network constraints also affect tariffs. No charging control or price guarantee.</p>
          <p><a target="_blank" rel="noopener noreferrer" href="${SOURCE_URL}">NESO forecast data</a> ·
          <a target="_blank" rel="noopener noreferrer" href="${DATA_LICENCE_URL}">NESO Open Licence</a> · Unofficial community card</p>
        </footer></ha-card>`;
      this.shadowRoot.querySelector("button").addEventListener("click", () => this._refresh());
    }

    static getStubConfig() {
      return { title: "NESO charging outlook" };
    }

    static getConfigElement() {
      return document.createElement("neso-ev-charging-outlook-editor");
    }

    setConfig(config) {
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("A card configuration is required.");
      if (config.title !== undefined && typeof config.title !== "string") throw new Error("title must be a string.");
      this._config = { ...config };
      this._render();
    }

    set hass(_hass) {}

    getCardSize() {
      return 16;
    }

    connectedCallback() {
      this._render();
      this._refresh();
      this._poll = setInterval(() => this._refresh(), REFRESH_MS);
      this._clock = setInterval(() => this._render(), 60000);
    }

    disconnectedCallback() {
      clearInterval(this._poll);
      clearInterval(this._clock);
      this._request?.abort();
      this._request = null;
      this._loading = false;
    }

    async _refresh() {
      if (!this.isConnected || this._loading) return;
      const request = new AbortController();
      this._request = request;
      this._loading = true;
      this._render();
      try {
        const payload = await fetchForecast({ signal: request.signal });
        if (this._request !== request || !this.isConnected) return;
        buildOutlook(payload);
        this._payload = payload;
        this._error = null;
      } catch (error) {
        if (this._request !== request || request.signal.aborted || !this.isConnected) return;
        this._payload = null;
        this._error = error instanceof Error ? error.message : "The NESO forecast could not be loaded.";
      } finally {
        if (this._request === request) {
          this._loading = false;
          this._request = null;
          if (this.isConnected) this._render();
        }
      }
    }

    _render() {
      const now = Date.now();
      let outlook = rankNights(upcomingNights(now));
      let warning = this._error;
      if (this._payload) {
        try {
          outlook = buildOutlook(this._payload, now);
        } catch (error) {
          warning = error instanceof Error ? error.message : "The forecast is unavailable.";
        }
      }
      const root = this.shadowRoot;
      root.querySelector("h2").textContent = this._config.title?.trim() || "NESO charging outlook";
      const button = root.querySelector("button");
      button.disabled = this._loading;
      button.textContent = this._loading ? "Refreshing…" : "Refresh";
      const status = root.querySelector(".status");
      const noCoverage = outlook.issue && !outlook.validCount;
      status.classList.toggle("warning", Boolean(warning || noCoverage));
      status.textContent = warning || (outlook.issue ?
        `Issued ${issueLabel.format(outlook.issue)} · ${outlook.validCount}/14 complete nights` +
          (noCoverage ? " · No complete overnight coverage; no recommendations." : "") :
        this._loading ? "Loading the latest NESO forecast…" : "No forecast loaded. Refresh to try again.");
      const summary = root.querySelector(".summary");
      summary.textContent = outlook.noPreference ?
        "No preference: all valid nightly averages are identical. Each scores 50." :
        outlook.candidates.length ? "Up to three highest forecast wind averages. Not predicted cheapest nights; ties use date order." :
        "No wind-based recommendation is available.";
      const candidates = root.querySelector(".candidates");
      candidates.replaceChildren();
      for (const night of outlook.candidates) {
        const chip = element("div", undefined, "candidate");
        chip.append(element("strong", night.label),
          element("span", `${(night.averageMw / 1000).toFixed(2)} GW · ${night.score}/100${night.longRange ? " · Long range" : ""}`));
        candidates.append(chip);
      }
      const tbody = root.querySelector("tbody");
      const rows = outlook.nights.map((night) => {
        const row = element("tr");
        const date = element("th");
        date.scope = "row";
        date.style.textAlign = "left";
        date.append(element("span", night.label, "date"));
        if (night.longRange) date.append(element("span", "Long range", "range"));
        const wind = element("td", night.averageMw === null ? "—" : (night.averageMw / 1000).toFixed(2));
        const score = element("td");
        if (night.score === null) {
          score.append(element("span", "No signal", "missing"));
          score.title = night.reason || "No valid forecast";
          score.setAttribute("aria-label", `No signal: ${night.reason || "No valid forecast"}`);
        } else {
          const visualization = element("div", undefined, "score");
          const track = element("div", undefined, "track");
          track.setAttribute("aria-hidden", "true");
          const fill = element("div", undefined, `fill ${night.color}`);
          fill.style.width = `${night.score}%`;
          track.append(fill);
          visualization.append(track, element("span", String(night.score), "number"));
          score.append(visualization);
          score.setAttribute("aria-label", `Relative wind score ${night.score} out of 100`);
        }
        row.append(date, wind, score);
        return row;
      });
      tbody.replaceChildren(...rows);
    }
  }

  class NesoEvChargingOutlookEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `<style>
        :host { display:block; padding:12px; color:var(--primary-text-color,#202b36); }
        label { display:block; font:inherit; } input { box-sizing:border-box; width:100%; margin-top:8px;
          padding:12px; border:1px solid var(--divider-color,#aaa); border-radius:6px; font:inherit;
          background:var(--card-background-color,#fff); color:inherit; }
        p { font-size:13px; line-height:1.5; color:var(--secondary-text-color,#526170); }
      </style><label>Title<input type="text" placeholder="NESO charging outlook"></label>
      <p>NESO national wind only. No entities, tariff prices or vehicle control. All windows use Europe/London.</p>`;
      this.shadowRoot.querySelector("input").addEventListener("input", (event) => {
        this._config = { ...this._config, title: event.target.value };
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: { ...this._config } }, bubbles: true, composed: true,
        }));
      });
    }
    setConfig(config) {
      this._config = { ...config };
      this.shadowRoot.querySelector("input").value = config.title ?? "";
    }
    set hass(_hass) {}
  }

  if (!customElements.get("neso-ev-charging-outlook")) customElements.define("neso-ev-charging-outlook", NesoEvChargingOutlook);
  if (!customElements.get("neso-ev-charging-outlook-editor")) customElements.define("neso-ev-charging-outlook-editor", NesoEvChargingOutlookEditor);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "neso-ev-charging-outlook")) {
    window.customCards.push({
      type: "neso-ev-charging-outlook", name: "NESO charging outlook", preview: true,
      description: "14-night relative wind-based charging advice from NESO. No entities required.",
    });
  }
}
