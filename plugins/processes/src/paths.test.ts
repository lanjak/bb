import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_PAGE_SIZE,
  MAX_ENVIRONMENT_PAGES,
  MAX_MACHINE_PATHS,
  readAllEnvironments,
  selectMachinePaths,
  type PathEnvironment,
} from "./paths.js";

function environment(
  index: number,
  overrides: Partial<PathEnvironment> = {},
): PathEnvironment {
  return {
    path: `/work/env-${index}`,
    status: "ready",
    hostLifecycle: "active",
    updatedAt: index,
    createdAt: index,
    ...overrides,
  };
}

describe("selectMachinePaths", () => {
  it("never sends more paths than the host accepts", () => {
    const many = Array.from({ length: 300 }, (_, index) => environment(index));
    expect(selectMachinePaths(many)).toHaveLength(MAX_MACHINE_PATHS);
  });

  it("keeps the live and newest environments and drops the oldest and destroyed ones", () => {
    const environments = [
      ...Array.from({ length: 100 }, (_, index) => environment(index)),
      environment(1000, { status: "destroyed" }),
      environment(2000, { status: "error", updatedAt: 5_000 }),
      environment(3000, { path: null }),
      environment(4000, { path: "" }),
    ];
    const paths = selectMachinePaths(environments);
    expect(paths).toHaveLength(MAX_MACHINE_PATHS);
    expect(paths[0]).toBe("/work/env-99");
    expect(paths).toContain("/work/env-36");
    expect(paths).not.toContain("/work/env-35");
    expect(paths).not.toContain("/work/env-1000");
    expect(paths.at(-1)).toBe("/work/env-36");
  });

  it("puts a live environment ahead of a newer one that is not live", () => {
    const paths = selectMachinePaths([
      environment(1, { updatedAt: 1 }),
      environment(2, { status: "error", updatedAt: 999 }),
      environment(3, { hostLifecycle: "removing", updatedAt: 998 }),
    ]);
    expect(paths).toEqual(["/work/env-1", "/work/env-2", "/work/env-3"]);
  });

  it("sends a path once", () => {
    expect(
      selectMachinePaths([
        environment(1, { path: "/same" }),
        environment(2, { path: "/same" }),
      ]),
    ).toEqual(["/same"]);
  });
});

describe("readAllEnvironments", () => {
  it("pages until a short page, and stops at its page limit", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => index);
    const offsets: number[] = [];
    await expect(
      readAllEnvironments(async (offset) => {
        offsets.push(offset);
        return rows.slice(offset, offset + ENVIRONMENT_PAGE_SIZE);
      }),
    ).resolves.toEqual(rows);
    expect(offsets).toEqual([0, 100, 200]);
    let calls = 0;
    await readAllEnvironments(async () => {
      calls += 1;
      return Array.from({ length: ENVIRONMENT_PAGE_SIZE }, () => 0);
    });
    expect(calls).toBe(MAX_ENVIRONMENT_PAGES);
  });
});
