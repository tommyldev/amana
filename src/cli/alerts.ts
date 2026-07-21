import { parseArgs } from "node:util";
import { cliContext } from "./context.ts";
import { saveConfig } from "../config/config.ts";
import { notify } from "../alerts/notify.ts";

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      thresholds: { type: "string" },
      desktop: { type: "string" },
      enabled: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const sub = positionals[0];
  const { paths, cfg } = cliContext();

  switch (sub) {
    case "set": {
      if (values.thresholds !== undefined) {
        const raw = values.thresholds
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const parsed: number[] = [];
        for (const s of raw) {
          const n = Number.parseInt(s, 10);
          if (!Number.isFinite(n) || n < 1 || n > 100) {
            throw new Error(`alerts set: threshold must be an integer in 1..100 (got "${s}")`);
          }
          parsed.push(n);
        }
        cfg.alerts.thresholds = [...new Set(parsed)].sort((a, b) => a - b);
      }
      if (values.desktop !== undefined) {
        cfg.alerts.desktop = parseBool(values.desktop, "desktop");
      }
      if (values.enabled !== undefined) {
        cfg.alerts.enabled = parseBool(values.enabled, "enabled");
      }
      saveConfig(paths.configFile, cfg);
      printAlerts(cfg);
      return;
    }
    case "test": {
      notify("amana: test alert", "This is a test notification from amana alerts test");
      console.log("fired a test notification (check your desktop; on failure see stderr)");
      return;
    }
    default:
      throw new Error("alerts: subcommand must be 'set' or 'test'");
  }
}

function parseBool(s: string, flag: string): boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  throw new Error(`alerts set: --${flag} must be 'true' or 'false' (got "${s}")`);
}

function printAlerts(cfg: { alerts: { enabled: boolean; thresholds: number[]; desktop: boolean } }): void {
  const a = cfg.alerts;
  console.log(
    `alerts: enabled=${a.enabled} thresholds=[${a.thresholds.join(",")}] desktop=${a.desktop}`,
  );
}