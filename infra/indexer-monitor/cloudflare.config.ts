import { bindings, defineConfig, exports } from "cf/config";

// Off-host receiver for the indexer's production monitor
// (docs/INDEXER-MONITOR.md). Built and deployed only with `cf` from this
// directory, never by the indexer's App Platform workflow. `--mode canary`
// deploys an isolated copy with its own state and token for alert drills.
export default defineConfig(({ mode }) => {
  if (mode && mode !== "production" && mode !== "canary")
    throw new Error("Unknown indexer monitor deployment mode");
  const name = mode === "canary" ? "indexer-monitor-canary" : "indexer-monitor";
  return {
    accountId: "33bdfdfdcdce2c31ff2b755dd113664f",
    worker: {
      name,
      compatibilityDate: "2026-11-01",
      entrypoint: "src/index.ts",
      workersDev: false,
      previewUrls: false,
      observability: { enabled: true, logs: { invocationLogs: false } },
      domains: [`${name}.ekubo.org`],
      exports: { MonitorState: exports.durableObject({ storage: "sqlite" }) },
      env: {
        STATE: bindings.durableObject({
          worker: name,
          exportName: "MonitorState",
        }),
        REPORT_TOKEN: bindings.secret(),
        CANARY: mode === "canary" ? bindings.text("1") : undefined,
      },
    },
  };
});
