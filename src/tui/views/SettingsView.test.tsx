/**
 * The Settings view describes alert behavior accurately: alerts fire on live
 * quota AND locally configured caps (cycles 2 + 10), not just "a live limit".
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { SettingsView } from "./SettingsView.tsx";
import { initialState } from "../state.ts";

const alerts = { enabled: true, thresholds: [75, 90, 100], desktop: true };

describe("SettingsView", () => {
  const frame = () => render(<SettingsView state={initialState(alerts)} />).lastFrame() ?? "";

  test("help text credits configured caps, not only live limits", () => {
    const f = frame();
    expect(f).toContain("configured cap");
    expect(f).not.toContain("a live limit crosses");
  });

  test("shows the alert setting rows", () => {
    const f = frame();
    expect(f).toContain("Alerts enabled");
    expect(f).toContain("Desktop notifications");
    expect(f).toContain("Alert thresholds");
  });
});
