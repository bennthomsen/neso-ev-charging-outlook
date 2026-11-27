import { upcomingNights } from "../neso-ev-charging-outlook.js";

export const FIXTURE_NOW = Date.parse("2026-11-27T21:00:00Z");
export const DEMO_AVERAGES = [8200, 12400, 16600, 19400, 14300, 7100, 4800, 10800, 17200, 15200, 9200, 6400, 11800, 13500];

export function fixture({ now = FIXTURE_NOW, averages = DEMO_AVERAGES, issue = now } = {}) {
  let id = 0;
  const records = upcomingNights(now).flatMap((night, index) => night.slots.map((timestamp) => ({
    _id: ++id,
    Datetime: new Date(timestamp).toISOString().slice(0, 19),
    ForecastDateTime: new Date(issue).toISOString().slice(0, 19),
    Wind_Forecast: averages[index % averages.length],
    Capacity: 30000,
  })));
  return { success: true, result: { records, total: records.length } };
}
