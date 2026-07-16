import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import type {
  AuthMethod,
  Config,
  LimitsCfg,
  ProviderCfg,
  WindowCfg,
  WindowType,
} from "./types.ts";
import { DEFAULT_REFRESH_SECONDS, defaultAlerts, defaultConfig } from "./defaults.ts";

const WINDOW_TYPES: WindowType[] = ["rolling", "daily", "weekly", "monthly"];
const AUTH_METHODS: AuthMethod[] = ["api_key", "oauth", "none"];

function normWindow(raw: unknown): WindowCfg {
  const r = (raw ?? {}) as Record<string, unknown>;
  const type = WINDOW_TYPES.includes(r.type as WindowType) ? (r.type as WindowType) : "rolling";
  const duration = typeof r.duration === "string" ? r.duration : type === "rolling" ? "5h" : undefined;
  return duration === undefined ? { type } : { type, duration };
}

function normLimits(raw: unknown): LimitsCfg {
  const r = (raw ?? {}) as Record<string, unknown>;
  const limits: LimitsCfg = {};
  if (typeof r.window_token_limit === "number") limits.window_token_limit = r.window_token_limit;
  if (typeof r.monthly_cost === "number") limits.monthly_cost = r.monthly_cost;
  return limits;
}

function normProvider(raw: unknown): ProviderCfg | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  const extra = Array.isArray(r.extra_windows) ? r.extra_windows.map(normWindow) : [];
  return {
    id: r.id,
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
    auth_method: AUTH_METHODS.includes(r.auth_method as AuthMethod) ? (r.auth_method as AuthMethod) : "none",
    usage_window: normWindow(r.usage_window),
    extra_windows: extra,
    limits: normLimits(r.limits),
  };
}

function normalizeConfig(raw: Record<string, unknown>): Config {
  const ui = (raw.ui ?? {}) as Record<string, unknown>;
  const alerts = (raw.alerts ?? {}) as Record<string, unknown>;
  const rawProviders = Array.isArray(raw.providers) ? raw.providers : [];
  const providers = rawProviders.map(normProvider).filter((p): p is ProviderCfg => p !== null);
  const defAlerts = defaultAlerts();
  return {
    ui: {
      refresh_interval_seconds:
        typeof ui.refresh_interval_seconds === "number"
          ? ui.refresh_interval_seconds
          : DEFAULT_REFRESH_SECONDS,
    },
    alerts: {
      enabled: typeof alerts.enabled === "boolean" ? alerts.enabled : defAlerts.enabled,
      thresholds:
        Array.isArray(alerts.thresholds) && alerts.thresholds.every((t) => typeof t === "number")
          ? (alerts.thresholds as number[])
          : defAlerts.thresholds,
      desktop: typeof alerts.desktop === "boolean" ? alerts.desktop : defAlerts.desktop,
    },
    providers,
  };
}

/** Load config, creating a default file if absent and merging in any
 * default providers missing from the file (port of Rust `Config::load`). */
export function loadConfig(file: string): Config {
  if (!existsSync(file)) {
    const cfg = defaultConfig();
    saveConfig(file, cfg);
    return cfg;
  }
  const cfg = normalizeConfig(parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  for (const d of defaultConfig().providers) {
    if (!cfg.providers.some((p) => p.id === d.id)) cfg.providers.push(d);
  }
  return cfg;
}

function serializable(cfg: Config): Record<string, unknown> {
  return {
    ui: { refresh_interval_seconds: cfg.ui.refresh_interval_seconds },
    alerts: { enabled: cfg.alerts.enabled, thresholds: cfg.alerts.thresholds, desktop: cfg.alerts.desktop },
    providers: cfg.providers.map((p) => {
      const usage = window_(p.usage_window);
      const limits: Record<string, number> = {};
      if (p.limits.window_token_limit !== undefined) limits.window_token_limit = p.limits.window_token_limit;
      if (p.limits.monthly_cost !== undefined) limits.monthly_cost = p.limits.monthly_cost;
      return {
        id: p.id,
        enabled: p.enabled,
        auth_method: p.auth_method,
        usage_window: usage,
        extra_windows: p.extra_windows.map(window_),
        limits,
      };
    }),
  };
}

function window_(w: WindowCfg): Record<string, unknown> {
  return w.duration === undefined ? { type: w.type } : { type: w.type, duration: w.duration };
}

export function saveConfig(file: string, cfg: Config): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(serializable(cfg)));
}

export function providerCfg(cfg: Config, id: string): ProviderCfg | undefined {
  return cfg.providers.find((p) => p.id === id);
}

export function upsertProviderWindow(cfg: Config, id: string, w: WindowCfg): void {
  const p = cfg.providers.find((x) => x.id === id);
  if (p) {
    p.usage_window = w;
    return;
  }
  cfg.providers.push({
    id,
    enabled: true,
    auth_method: "none",
    usage_window: w,
    extra_windows: [],
    limits: {},
  });
}

export function upsertProviderLimit(
  cfg: Config,
  id: string,
  cost: number | undefined,
  tokens: number | undefined,
): void {
  const p = cfg.providers.find((x) => x.id === id);
  if (p) {
    if (cost !== undefined) p.limits.monthly_cost = cost;
    if (tokens !== undefined) p.limits.window_token_limit = tokens;
    return;
  }
  const limits: LimitsCfg = {};
  if (cost !== undefined) limits.monthly_cost = cost;
  if (tokens !== undefined) limits.window_token_limit = tokens;
  cfg.providers.push({
    id,
    enabled: true,
    auth_method: "none",
    usage_window: { type: "rolling", duration: "5h" },
    extra_windows: [],
    limits,
  });
}
