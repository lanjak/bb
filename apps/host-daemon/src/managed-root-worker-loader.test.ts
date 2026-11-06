import { describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  exports: new Map<string, unknown>(),
  readFile: vi.fn(),
  source: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: boundary.readFile }));
vi.mock("node:vm", () => ({
  SyntheticModule: class {
    constructor(_names: string[], initialize: (this: { setExport(name: string, value: unknown): void }) => void) {
      initialize.call({ setExport: (name, value) => { boundary.exports.set(name, value); } });
    }
  },
  SourceTextModule: boundary.source,
}));
import { createManagedRootWorkerLoader } from "./managed-root-worker-loader.js";
import { createManagedRootWorkerWitness } from "./managed-root-worker-witness.js";

describe("private worker loader", () => {
  it("installs only the original verifier and refuses before artifact reads or compilation", async () => {
    const witness = createManagedRootWorkerWitness("generation-1");
    const loader = createManagedRootWorkerLoader(witness);
    expect(boundary.exports.size).toBe(1);
    expect(boundary.exports.get("verifyOriginalManagedRootContext")).toBe(witness.verifyOriginalManagedRootContext);
    await expect(loader.load("/not-read/host.js")).rejects.toThrow("native producer");
    expect(boundary.readFile).not.toHaveBeenCalled();
    expect(boundary.source).not.toHaveBeenCalled();
  });
});
