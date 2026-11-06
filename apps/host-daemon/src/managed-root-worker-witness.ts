export function createManagedRootWorkerWitness(generation: string) {
  const contexts = new WeakSet<object>();
  const failures: unknown[] = [];
  const unavailable = Object.assign(
    new Error(`Managed root UNAVAILABLE for generation ${generation}: original native producer must validate inherited root and sentinel handles, ancestor attachment, aliases, cohort epoch and native lease; participant admission is separate`),
    { code: "UNAVAILABLE" },
  );
  let revoked = false;
  const assertProducerAvailable = (): never => { throw unavailable; };
  return Object.freeze({
    assertProducerAvailable,
    registerContext(context: object): () => void {
      if (revoked) throw new Error("Managed root worker is revoked");
      contexts.add(context);
      return () => { contexts.delete(context); };
    },
    verifyOriginalManagedRootContext(context: unknown): never {
      if (revoked) throw new Error("Managed root worker is revoked");
      if (typeof context !== "object" || context === null || !contexts.has(context)) {
        throw new Error("Managed root requires the original context");
      }
      return assertProducerAvailable();
    },
    revoke(): void { revoked = true; },
    retainCleanupUncertainty(reason: unknown): void { failures.push(reason); },
    cleanupUncertainty(): readonly unknown[] { return failures.slice(); },
  });
}
