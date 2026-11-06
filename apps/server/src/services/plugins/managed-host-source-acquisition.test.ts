import { describe, expect, it } from "vitest";
import { createManagedHostSourceAcquisition } from "./managed-host-source-acquisition.js";

function thrownBy(operation: () => never): unknown {
  try { operation(); } catch (reason) { return reason; }
  throw new Error("Expected acquisition refusal");
}

describe("unavailable original managed source acquisition", () => {
  it("preserves the same refusal at every proposed effect boundary", () => {
    const owner = createManagedHostSourceAcquisition();
    const original = thrownBy(owner.assertBeforeSourceEffects);
    expect(original).toBeInstanceOf(Error);
    for (const boundary of [owner.assertBeforeBuildEffects, owner.assertBeforeCacheReuse, owner.assertBeforeDaemonMaterialization]) {
      expect(thrownBy(boundary)).toBe(original);
    }
    expect(owner.snapshot().phase).toBe("unavailable");
  });

  it("retains opaque cleanup uncertainty after revocation without allowing new effects", () => {
    const owner = createManagedHostSourceAcquisition();
    const original = thrownBy(owner.assertBeforeSourceEffects);
    owner.retainCleanupUncertainty(undefined);
    const before = owner.snapshot();
    owner.revoke();
    const lateFailure = {};
    owner.retainCleanupUncertainty(lateFailure);
    expect(thrownBy(owner.assertBeforeDaemonMaterialization)).toBe(original);
    expect(before.cleanupUncertainty).toEqual([undefined]);
    expect(owner.snapshot().phase).toBe("revoked");
    expect(owner.snapshot().cleanupUncertainty).toEqual([undefined, lateFailure]);
    expect(owner.snapshot().cleanupUncertainty[1]).toBe(lateFailure);
    expect(Object.isFrozen(owner.snapshot().cleanupUncertainty)).toBe(true);
  });
});
