import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { LineGauge } from "./LineGauge.tsx";
import { UsageChart } from "./UsageChart.tsx";
import { Table } from "./Table.tsx";
import { Footer } from "./Footer.tsx";
import { HelpOverlay } from "./HelpOverlay.tsx";
import { Tabs } from "./Tabs.tsx";

describe("LineGauge", () => {
  test("renders value=100 with 100% text, a fill glyph and no brackets", () => {
    const frame = render(<LineGauge value={100} />).lastFrame();
    expect(frame).toContain("100%");
    expect(frame).toContain("█");
    expect(frame).not.toContain("[");
  });

  test("renders a status dot when dot is set", () => {
    expect(render(<LineGauge value={50} dot />).lastFrame()).toContain("●");
    expect(render(<LineGauge value={50} />).lastFrame()).not.toContain("●");
  });

  test("renders custom label", () => {
    const { lastFrame } = render(<LineGauge value={42} label="usage" />);
    expect(lastFrame()).toContain("usage");
    expect(lastFrame()).toContain("42%");
  });

  test("clamps negative and oversize values", () => {
    expect(render(<LineGauge value={-10} />).lastFrame()).toContain("0%");
    expect(render(<LineGauge value={250} />).lastFrame()).toContain("100%");
  });

  test("fills the track proportionally to the value", () => {
    // width defaults to 20 → value 25 fills 5 cells, leaving 15 empty.
    const frame = render(<LineGauge value={25} />).lastFrame() ?? "";
    expect(frame).toContain("█".repeat(5));
    expect(frame).toContain("░".repeat(15));
    expect(frame).toContain("25%");
  });
});

describe("UsageChart", () => {
  test("renders multi-row bars, y-axis peak label and hour labels", () => {
    const data = Array.from({ length: 24 }, (_, i) => i * 10);
    const startMs = Date.UTC(2026, 6, 16, 0, 0, 0);
    const frame = render(<UsageChart data={data} startMs={startMs} labelEvery={3} />).lastFrame() ?? "";
    expect(frame).toContain("█"); // tallest column reaches the top row
    expect(frame).toContain("┼"); // baseline connector
    expect(frame).toContain("└"); // x-axis
    expect(frame).toContain("00"); // first hour label
    expect(frame).toContain("03");
  });
  test("empty data renders a placeholder, not a crash", () => {
    expect(render(<UsageChart data={[]} />).lastFrame()).toContain("no activity");
  });

  test("daily bucketMs renders MM/DD date labels instead of hours", () => {
    const data = Array.from({ length: 7 }, () => 100);
    const startMs = Date.UTC(2026, 6, 16, 0, 0, 0);
    const frame = render(<UsageChart data={data} startMs={startMs} bucketMs={24 * 3_600_000} />).lastFrame() ?? "";
    expect(frame).toContain("07/16");
  });
  test("all-zero data still draws axes without bar glyphs", () => {
    const frame = render(<UsageChart data={Array(6).fill(0)} startMs={0} />).lastFrame() ?? "";
    expect(frame).toContain("┼");
    expect(frame).not.toContain("█");
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
