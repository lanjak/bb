export function createManagedHostSourceAcquisition() {
  const unavailable = Object.assign(new Error(
    "Managed source acquisition UNAVAILABLE: original producer has no physical parent, root, generation or fixed checkout association",
  ), { code: "UNAVAILABLE" });
  const uncertainty: unknown[] = [];
  let phase: "unavailable" | "revoked" = "unavailable";
  const refuse = (): never => { throw unavailable; };
  return Object.freeze({
    assertBeforeSourceEffects: refuse,
    assertBeforeBuildEffects: refuse,
    assertBeforeCacheReuse: refuse,
    assertBeforeDaemonMaterialization: refuse,
    revoke(): void { phase = "revoked"; },
    retainCleanupUncertainty(reason: unknown): void { uncertainty.push(reason); },
    snapshot(): Readonly<{
      phase: "unavailable" | "revoked";
      cleanupUncertainty: readonly unknown[];
    }> {
      return Object.freeze({ phase, cleanupUncertainty: Object.freeze(uncertainty.slice()) });
    },
  });
}
