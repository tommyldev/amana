import type { AlertsCfg, Config, ProviderCfg, WindowCfg } from "./types.ts";
import { KNOWN_PROVIDERS } from "../registry.ts";

export const DEFAULT_REFRESH_SECONDS = 60;
export const DEFAULT_THRESHOLDS = [75, 90, 100];

export function defaultAlerts(): AlertsCfg {
  return { enabled: true, thresholds: [...DEFAULT_THRESHOLDS], desktop: true };
}

function rolling(d: string): WindowCfg {
  return { type: "rolling", duration: d };
}

/**
 * One ProviderCfg per known provider, with window(s) derived from each
 * provider's reset cadence. Only the raw log aggregates (omp, claude-code)
 * are enabled by default; everything else is opted in via `atop login`.
 */
export function defaultProviders(): ProviderCfg[] {
  return KNOWN_PROVIDERS.map((def) => {
    const enabled = def.id === "omp" || def.id === "claude-code";
    let usage_window: WindowCfg;
    let extra_windows: WindowCfg[] = [];
    switch (def.cadence) {
      case "FiveHourWeekly":
        usage_window = rolling("5h");
        extra_windows = [{ type: "weekly", duration: "mon" }];
        break;
      case "FiveHour":
        usage_window = rolling("5h");
        break;
      case "Daily":
        usage_window = { type: "daily" };
        break;
      case "Monthly":
        usage_window = { type: "monthly", duration: "1" };
        break;
    }
    return {
      id: def.id,
      enabled,
      auth_method: def.needsKey ? "api_key" : "none",
      usage_window,
      extra_windows,
      limits: {},
    };
  });
}

export function defaultConfig(): Config {
  return {
    ui: { refresh_interval_seconds: DEFAULT_REFRESH_SECONDS },
    alerts: defaultAlerts(),
    providers: defaultProviders(),
  };
}
