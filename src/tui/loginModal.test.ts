import { test, expect, describe } from "bun:test";
import { loginModalReducer, type LoginModalState } from "./loginModal.ts";

describe("loginModalReducer", () => {
  test("open starts on the filterable list; close returns null", () => {
    const opened = loginModalReducer(null, { t: "open" });
    expect(opened).toEqual({ view: "list", filter: "", selection: 0 });
    expect(loginModalReducer(opened, { t: "close" })).toBeNull();
  });

  test("typing appends to the filter and resets selection", () => {
    let s: LoginModalState = { view: "list", filter: "an", selection: 3 };
    s = loginModalReducer(s, { t: "filterChar", ch: "t" });
    expect(s).toEqual({ view: "list", filter: "ant", selection: 0 });
    s = loginModalReducer(s, { t: "filterBackspace" });
    expect(s).toEqual({ view: "list", filter: "an", selection: 0 });
  });

  test("filter actions are ignored in detail view", () => {
    const detail: LoginModalState = { view: "detail", providerId: "zai", selection: 0 };
    expect(loginModalReducer(detail, { t: "filterChar", ch: "x" })).toBe(detail);
  });

  test("move wraps within count in both views", () => {
    const list: LoginModalState = { view: "list", filter: "", selection: 0 };
    expect(loginModalReducer(list, { t: "move", delta: -1, count: 3 })).toMatchObject({ selection: 2 });
    const detail: LoginModalState = { view: "detail", providerId: "zai", selection: 2 };
    expect(loginModalReducer(detail, { t: "move", delta: 1, count: 3 })).toMatchObject({ selection: 0 });
  });

  test("move clamps to 0 when there are no rows", () => {
    const list: LoginModalState = { view: "list", filter: "", selection: 5 };
    expect(loginModalReducer(list, { t: "move", delta: 1, count: 0 })).toMatchObject({ selection: 0 });
  });

  test("toDetail/toList switch views and reset selection", () => {
    const detail = loginModalReducer({ view: "list", filter: "z", selection: 2 }, { t: "toDetail", providerId: "zai" });
    expect(detail).toEqual({ view: "detail", providerId: "zai", selection: 0 });
    expect(loginModalReducer(detail, { t: "toList" })).toEqual({ view: "list", filter: "", selection: 0 });
  });
});
