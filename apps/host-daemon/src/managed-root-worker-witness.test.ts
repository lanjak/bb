import { describe, expect, it } from "vitest";
import { createManagedRootWorkerWitness } from "./managed-root-worker-witness.js";

describe("original managed root worker context", () => {
  it("distinguishes exact original contexts without granting physical authority", () => {
    const witness = createManagedRootWorkerWitness("generation-1");
    const context = {};
    const unregister = witness.registerContext(context);
    expect(() => witness.verifyOriginalManagedRootContext({})).toThrow("original context");
    expect(() => witness.verifyOriginalManagedRootContext(context)).toThrow("native producer");
    unregister();
    expect(() => witness.verifyOriginalManagedRootContext(context)).toThrow("original context");
    const replacement = createManagedRootWorkerWitness("generation-2");
    expect(() => replacement.verifyOriginalManagedRootContext(context)).toThrow("original context");
  });

  it("revokes registration without dropping opaque cleanup uncertainty", () => {
    const witness = createManagedRootWorkerWitness("generation-1");
    const context = {};
    witness.registerContext(context);
    const secondary = {};
    witness.retainCleanupUncertainty(undefined);
    witness.retainCleanupUncertainty(secondary);
    witness.revoke();
    expect(() => witness.registerContext({})).toThrow("revoked");
    expect(() => witness.verifyOriginalManagedRootContext(context)).toThrow("revoked");
    expect(witness.cleanupUncertainty()).toEqual([undefined, secondary]);
    expect(witness.cleanupUncertainty()[1]).toBe(secondary);
  });

  it("keeps the original missing-producer error for registered calls", () => {
    const witness = createManagedRootWorkerWitness("generation-1");
    const context = {};
    witness.registerContext(context);
    let original: unknown;
    try { witness.assertProducerAvailable(); } catch (error) { original = error; }
    expect(original).toBeInstanceOf(Error);
    try { witness.verifyOriginalManagedRootContext(context); } catch (error) { expect(error).toBe(original); }
  });
});
