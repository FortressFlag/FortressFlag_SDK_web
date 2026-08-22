// A dependency-free static server for the example page, on a port ≠ 8080 ON PURPOSE: the
// page must be a DIFFERENT origin than the backend, so the browser actually performs the
// CORS preflight the walkthrough asserts (same-origin dev would hide a broken Step-2 branch
// forever — Trap 2).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = 5199;
const ROOT = new URL("..", import.meta.url).pathname;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
};

createServer(async (req, res) => {
  // Redirect rather than aliasing "/" to the file: the page's relative ./main.js must
  // resolve under /example/, or the browser asks for /main.js and gets a 404.
  if (req.url === "/" || req.url === "/example") {
    res.writeHead(302, { Location: "/example/" }).end();
    return;
  }
  const path = req.url === "/example/" ? "/example/index.html" : (req.url ?? "/");
  const file = normalize(join(ROOT, path.split("?")[0]));
  if (!file.startsWith(normalize(ROOT))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => {
  console.log(
    `example: http://localhost:${PORT}/  (backend expected on :8080; run pnpm build first)`,
  );
});
