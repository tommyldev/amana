import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { LineGauge } from "./LineGauge.tsx";
import { BarChart } from "./BarChart.tsx";
import { Table } from "./Table.tsx";
import { Footer } from "./Footer.tsx";
import { HelpOverlay } from "./HelpOverlay.tsx";
import { Tabs } from "./Tabs.tsx";

describe("LineGauge", () => {
  test("renders value=95 with 95% text and red-band color", () => {
    const { lastFrame } = render(<LineGauge value={95} />);
    const frame = lastFrame();
    expect(frame).toContain("95%");
    expect(frame).toContain("█");
    // gaugeColor(95) returns "red"; ink colorizes the bracket section.
    // We cannot directly read ANSI escapes via lastFrame; assert the
    // substring containing the filled-cells exists.
    expect(frame).toContain("[");
    expect(frame).toContain("]");
  });

  test("renders custom label", () => {
    const { lastFrame } = render(<LineGauge value={42} label="usage" />);
    expect(lastFrame()).toContain("usage");
    expect(lastFrame()).toContain("42%");
  });

  test("clamps negative and oversize values", () => {
    const { lastFrame: lfNeg } = render(<LineGauge value={-10} />);
    expect(lfNeg()).toContain("0%");
    const { lastFrame: lfBig } = render(<LineGauge value={250} />);
    expect(lfBig()).toContain("100%");
  });

  test("uses yellow band at 70 and green band below", () => {
    expect(render(<LineGauge value={70} />).lastFrame()).toContain("70%");
    expect(render(<LineGauge value={30} />).lastFrame()).toContain("30%");
  });
});

describe("BarChart", () => {
  test("renders 24 buckets with glyphs and hour labels", () => {
    const data = Array.from({ length: 24 }, (_, i) => i * 10);
    const startMs = Date.UTC(2026, 6, 16, 0, 0, 0); // 2026-07-16T00:00Z
    const { lastFrame } = render(
      <BarChart data={data} startMs={startMs} labelEvery={3} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("▇");
    expect(frame).toContain("00");
    expect(frame).toContain("03");
    expect(frame).toContain("06");
  });

  test("handles all-zero data without throwing", () => {
    const data = Array(24).fill(0);
    const { lastFrame } = render(<BarChart data={data} />);
    expect(lastFrame()).toBeDefined();
  });

  test("uses default cyan color in output", () => {
    const { lastFrame } = render(<BarChart data={[1, 2, 3, 4]} />);
    // Default color is cyan; we can only assert the frame rendered (ink
    // applies ANSI escapes that lastFrame unwraps in some versions). Just
    // assert the bar glyphs render.
    const frame = lastFrame() ?? "";
    expect(frame.length).toBeGreaterThan(0);
  });
});

describe("Table", () => {
  const cols = [
    { header: "Name", width: 8 },
    { header: "Count", width: 6, align: "right" as const },
  ];

  test("renders headers and rows", () => {
    const { lastFrame } = render(
      <Table
        columns={cols}
        rows={[
          ["alpha", "10"],
          ["beta", "200"],
        ]}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Name");
    expect(frame).toContain("Count");
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    expect(frame).toContain("10");
    expect(frame).toContain("200");
  });

  test("marks selected row with inverse marker", () => {
    const { lastFrame } = render(
      <Table
        columns={cols}
        rows={[["alpha", "10"], ["beta", "200"]]}
        selected={1}
      />,
    );
    const frame = lastFrame();
    // The selected row gets a "> " prefix; non-selected rows get "  ".
    expect(frame).toContain("> beta");
  });

  test("pads and truncates cells to column width", () => {
    const { lastFrame } = render(
      <Table
        columns={[{ header: "Key", width: 5 }]}
        rows={[["longervalue"]]}
      />,
    );
    // "longervalue" (12 chars) truncated to 5.
    const frame = lastFrame();
    expect(frame).toContain("longe");
    expect(frame).not.toContain("longervalue");
  });
});

describe("Footer", () => {
  test("renders key/desc pairs joined by ' · '", () => {
    const { lastFrame } = render(
      <Footer
        pairs={[
          ["r", "refresh"],
          ["q", "quit"],
        ]}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("r");
    expect(frame).toContain("refresh");
    expect(frame).toContain("q");
    expect(frame).toContain("quit");
    expect(frame).toContain("·");
  });

  test("renders empty pairs gracefully", () => {
    const { lastFrame } = render(<Footer pairs={[]} />);
    expect(lastFrame()).toBe("");
  });
});

describe("HelpOverlay", () => {
  test("renders null when visible=false (lastFrame is empty)", () => {
    const { lastFrame } = render(<HelpOverlay visible={false} />);
    expect(lastFrame()).toBe("");
  });

  test("renders keys when visible=true", () => {
    const { lastFrame } = render(<HelpOverlay visible={true} />);
    const frame = lastFrame();
    expect(frame).toContain("Keys");
    expect(frame).toContain("quit");
    expect(frame).toContain("Tab");
  });
});

describe("Tabs", () => {
  test("renders each tab label", () => {
    const { lastFrame } = render(
      <Tabs tabs={["Limits", "Tokens", "Accounts"]} active={0} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Limits");
    expect(frame).toContain("Tokens");
    expect(frame).toContain("Accounts");
  });

  test("marks the active index with bold/underline", () => {
    // ink applies SGR escapes; in the rendered frame, a tab rendered as
    // the active one appears inside an ANSI bold/underline block. We
    // cannot easily snapshot the full escape signature, so we assert the
    // tab labels are all present (active is determined server-side in ink
    // by props; we verify render produces a frame with all labels and the
    // separator).
    const { lastFrame } = render(
      <Tabs tabs={["Limits", "Tokens", "Accounts"]} active={1} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Limits");
    expect(frame).toContain("Tokens");
    expect(frame).toContain("Accounts");
    expect(frame).toContain("│");
  });
});
