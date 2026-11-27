import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const metadata = JSON.parse(await readFile(resolve(root, "hacs.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (metadata.filename !== "neso-ev-charging-outlook.js" || metadata.content_in_root !== true) {
  throw new Error("HACS metadata must point to the self-contained root module.");
}
if (pkg.license !== "MIT" || pkg.private !== true) throw new Error("Keep the MIT package private until publication is authorized.");
for (const file of ["neso-ev-charging-outlook.js", "README.md", "LICENSE", "index.html", "screenshot.png"]) await access(resolve(root, file));
const source = await readFile(resolve(root, metadata.filename), "utf8");
if (/^\s*import\s/m.test(source)) throw new Error("The installable module must be self-contained.");
if (!source.includes('customElements.define("neso-ev-charging-outlook"')) throw new Error("Card registration missing.");
console.log("Local HACS packaging checks passed.");
