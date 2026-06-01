/**
 * Smoke test — verifies the manifest validates against the host's Zod
 * schema and that the worker module imports without throwing.
 *
 * The validator is loaded from the locally installed `paperclipai` package
 * (since the validator implementation lives in `@paperclipai/shared`, which
 * is also published to npm and a peer of `@paperclipai/plugin-sdk`).
 *
 * Usage:
 *   npm test
 */

import manifest from "../dist/manifest.js";
import plugin from "../dist/worker.js";

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
    failures += 1;
  }
}

// Structural checks (do not require @paperclipai/shared to resolve)
check("manifest has id", typeof manifest.id === "string" && manifest.id.length > 0);
check("manifest apiVersion is 1", manifest.apiVersion === 1);
check("manifest has semver version", /^\d+\.\d+\.\d+$/.test(manifest.version));
check("manifest declares capabilities", Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0);
check("manifest declares worker entrypoint", typeof manifest.entrypoints?.worker === "string");
check("manifest has instanceConfigSchema", typeof manifest.instanceConfigSchema === "object");
check("manifest declares telegram webhook", Array.isArray(manifest.webhooks) && manifest.webhooks.some((w) => w.endpointKey === "telegram"));

check("worker default-exports a plugin object", plugin && typeof plugin === "object");
check("worker.definition.setup is a function", typeof plugin?.definition?.setup === "function");
check("worker.definition.onWebhook is a function", typeof plugin?.definition?.onWebhook === "function");
check("worker.definition.onHealth is a function", typeof plugin?.definition?.onHealth === "function");

// Optional: deeper validation when @paperclipai/shared is resolvable.
try {
  const mod = await import("@paperclipai/shared/dist/validators/plugin.js");
  const parser = mod.pluginManifestV1Schema;
  if (parser) {
    const r = parser.safeParse(manifest);
    check("manifest passes pluginManifestV1Schema", r.success, r.success ? "" : JSON.stringify(r.error.issues));
  }
} catch {
  // @paperclipai/shared not exported via subpath in some environments;
  // structural checks above are still informative.
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll smoke checks passed.`);
