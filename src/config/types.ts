export type AuthMethod = "api_key" | "oauth" | "none";
export type WindowType = "rolling" | "daily" | "weekly" | "monthly";

export interface WindowCfg {
  type: WindowType;
  /**
   * Rolling: humantime duration ("5h"). Weekly: weekday ("mon").
   * Monthly: day-of-month ("1".."31"). Daily: unused.
   */
  duration?: string;
}

export interface LimitsCfg {
  window_token_limit?: number;
  monthly_cost?: number;
}

export interface ProviderCfg {
  id: string;
  enabled: boolean;
  auth_method: AuthMethod;
  usage_window: WindowCfg;
  extra_windows: WindowCfg[];
  limits: LimitsCfg;
}

export interface AlertsCfg {
  enabled: boolean;
  thresholds: number[];
  desktop: boolean;
}

export interface UiCfg {
  refresh_interval_seconds: number;
}

export interface Config {
  ui: UiCfg;
  alerts: AlertsCfg;
  providers: ProviderCfg[];
}
