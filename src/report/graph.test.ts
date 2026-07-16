import { test, expect } from "bun:test";
import { renderHourlyGraph } from "./graph.ts";

const START = Date.UTC(2026, 5, 27, 0, 0, 0); // 00:00 UTC

test("renders peak axis label, zero baseline, and full-height bar at the max", () => {
  const buckets = [0, 100, 400, 1000, 200, 0];
  const out = renderHourlyGraph(buckets, START, 6, 3);
  const lines = out.split("\n");
  // top row carries the peak label (1.0k) and the tallest bar reaches it
  expect(lines[0]).toContain("1.0k");
  expect(lines[0]).toContain("█");
  // baseline row shows the 0 axis label + the ┼ corner
  expect(lines[lines.length - 2].startsWith(" ")).toBe(true);
  const zeroRow = lines[height(out) - 1];
  expect(zeroRow).toContain("0");
  expect(zeroRow).toContain("┼");
  // x-axis + hour labels
  expect(out).toContain("└");
  expect(out).toContain("00"); // first bucket hour label
});

test("all-zero series renders bars-free but still has axes", () => {
  const out = renderHourlyGraph([0, 0, 0, 0], START, 4, 3);
  expect(out).toContain("┼");
  expect(out).toContain("└");
  expect(out).not.toContain("█");
});

test("column count matches bucket count on the bar rows", () => {
  const buckets = [10, 20, 30, 40, 50, 60, 70, 80];
  const out = renderHourlyGraph(buckets, START, 5, 3);
  const barRow = out.split("\n")[0]!;
  const afterConnector = barRow.slice(barRow.indexOf("┤") + 1);
  expect(afterConnector.length).toBe(buckets.length);
});

function height(out: string): number {
  // index of the row containing the ┼ baseline connector
  const lines = out.split("\n");
  return lines.findIndex((l) => l.includes("┼")) + 1;
}
