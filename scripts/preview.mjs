import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };
const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Invalid request URL");
    return;
  }
  const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(root + sep) || !types[extname(file)]) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file)], "Cache-Control": "no-store" }).end(content);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") response.writeHead(404).end("Not found");
    else {
      console.error(error);
      response.writeHead(500).end("Preview file could not be read");
    }
  }
});
server.on("error", (error) => { console.error(error); process.exitCode = 1; });
server.listen(8124, "127.0.0.1", () => console.log("NESO demo: http://127.0.0.1:8124/"));
