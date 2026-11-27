import "../neso-ev-charging-outlook.js";
import { fixture, FIXTURE_NOW } from "../tests/fixture.js";

Date.now = () => FIXTURE_NOW;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (url, options) => {
  if (!String(url).startsWith("https://api.neso.energy/")) return nativeFetch(url, options);
  const scenario = document.querySelector("#scenario").value;
  if (scenario === "network") throw new TypeError("Demo network failure");
  const payload = fixture({
    averages: scenario === "identical" ? [8000] : undefined,
    issue: scenario === "stale" ? FIXTURE_NOW - 7 * 3600000 : FIXTURE_NOW,
  });
  if (scenario === "missing") {
    payload.result.records.shift();
    payload.result.total--;
  }
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
};
function showCard() {
  const card = document.createElement("neso-ev-charging-outlook");
  card.setConfig({ type: "custom:neso-ev-charging-outlook" });
  document.querySelector("#card").replaceChildren(card);
}
document.querySelector("#scenario").addEventListener("change", showCard);
document.querySelector("#dark").addEventListener("change", (event) => {
  document.body.classList.toggle("dark", event.target.checked);
});
showCard();
