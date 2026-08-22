// The example page: no framework, no build step — the built SDK straight off `pnpm build`.
// Serves as the §6 walkthrough vehicle: renders allFlags() with provenance, a diagnostics
// panel, and a refresh button.
import { Environment, FortressFlag, SIGNATURE_DISABLED } from "../dist/index.js";

FortressFlag.start({
  // The committed dev seed key (make db-up migrate seed dev) — a local fixture, not a secret.
  sdkKey: "ffc_dev_seedseedseedseedseedseedseedseedseedseed000",
  environment: Environment.DEVELOPMENT,
  baseUrl: "http://localhost:8080",
  // Local development against a backend that does not sign yet (backend M4 unbuilt).
  signaturePolicy: SIGNATURE_DISABLED,
  refreshIntervalSeconds: 30,
  logging: "verbose",
});

const flagsBody = document.getElementById("flags");
const diagnostics = document.getElementById("diagnostics");

function render() {
  const all = FortressFlag.allFlags();
  if (all.size === 0) {
    flagsBody.innerHTML = `<tr><td colspan="3">(no flags yet — the cascade answers <code>false</code>)</td></tr>`;
  } else {
    flagsBody.innerHTML = [...all.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, resolution]) =>
          `<tr><td><code>${key}</code></td>` +
          `<td><code>${JSON.stringify(resolution.value.value)}</code></td>` +
          `<td class="source-${resolution.source}">${resolution.source}</td></tr>`,
      )
      .join("");
  }

  const d = FortressFlag.diagnostics;
  diagnostics.innerHTML =
    `<dt>Started</dt><dd>${d.isStarted}</dd>` +
    `<dt>Device identity</dt><dd><code id="device-id">${d.deviceIdentity ?? "(none yet)"}</code></dd>` +
    `<dt>Last successful fetch</dt><dd>${
      d.lastSuccessfulFetchEpochMillis === null
        ? "(never)"
        : new Date(d.lastSuccessfulFetchEpochMillis).toISOString()
    }</dd>` +
    `<dt>Fresh / cached flag count</dt><dd>${d.freshFlagCount} / ${d.cachedFlagCount}</dd>` +
    `<dt>Sent tag keys</dt><dd>${d.sentTagKeys.join(", ") || "(none)"}</dd>`;
}

FortressFlag.onChange(() => render());
document.getElementById("refresh").addEventListener("click", () => {
  void FortressFlag.refresh().then(render);
});
// The poll and the visibility hook drive changes through onChange; this keeps the
// diagnostics timestamps moving between changes.
setInterval(render, 1000);
render();
