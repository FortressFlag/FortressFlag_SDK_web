// The 10 kB gzip ceiling (ADR-0014). This SDK ships on customers' pages, where its bytes are
// the customer's page-load budget — the Frontend repo's watched-budget precedent ("the real
// emitted assets, gzipped — the number a user actually waits for"), scaled to a library.
//
// What is measured: the ENTRY GRAPH as a customer's bundler would ship it — dist/index.js
// bundled and minified by esbuild (a devDependency; nothing here ships in the SDK), then
// gzipped. Raw tsc output would overcount by roughly 2× (per-module boilerplate, long
// identifiers) and would gate a number no page ever downloads.
//
// The gate fails the build rather than warning: a warning is a ceiling that has already been
// raised, nobody just said so yet. Raising LIMIT_BYTES is a user-owned decision, not a fix.
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const LIMIT_BYTES = 10240;
const ENTRY = "dist/index.js";

if (!existsSync(ENTRY)) {
  console.error(`size-gate: ${ENTRY} does not exist — run tsc first (pnpm build does both).`);
  process.exit(1);
}

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  minify: true,
  format: "esm",
  write: false,
});
const artifact = result.outputFiles?.[0];
if (artifact === undefined) {
  console.error("size-gate: esbuild produced no output — the gate has nothing to measure.");
  process.exit(1);
}

const total = gzipSync(artifact.contents).length;
console.log(
  `size-gate: ${total} bytes gzipped (bundled+minified entry graph, ` +
    `${artifact.contents.length} bytes raw); limit ${LIMIT_BYTES}.`,
);
if (total > LIMIT_BYTES) {
  console.error(
    `size-gate: the built entry graph exceeds the 10 kB gzip ceiling (ADR-0014). ` +
      `Shrinking the code is the first answer; raising the ceiling is a user decision.`,
  );
  process.exit(1);
}
