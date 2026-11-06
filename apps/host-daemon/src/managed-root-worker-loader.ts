import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as vm from "node:vm";
import type { createManagedRootWorkerWitness } from "./managed-root-worker-witness.js";

const PRIVATE_VERIFIER = "bb-internal:original-managed-root-verifier";

export function createManagedRootWorkerLoader(
  witness: ReturnType<typeof createManagedRootWorkerWitness>,
) {
  if (typeof vm.SourceTextModule !== "function" || typeof vm.SyntheticModule !== "function") {
    throw new Error("Selected managed host requires --experimental-vm-modules; native import fallback is forbidden");
  }
  const verifier = new vm.SyntheticModule(
    ["verifyOriginalManagedRootContext"],
    function () {
      this.setExport("verifyOriginalManagedRootContext", witness.verifyOriginalManagedRootContext);
    },
    { identifier: PRIVATE_VERIFIER },
  );
  return Object.freeze({
    async load(artifactPath: string): Promise<unknown> {
      witness.assertProducerAvailable();
      const source = await readFile(artifactPath, "utf8");
      const artifact = new vm.SourceTextModule(source, {
        identifier: pathToFileURL(artifactPath).href,
        importModuleDynamically: async () => {
          throw new Error("Managed host dynamic imports are not approved");
        },
      });
      await artifact.link((specifier, referencingModule) => {
        if (referencingModule !== artifact || specifier !== PRIVATE_VERIFIER) {
          throw new Error(`Managed host import is not approved: ${specifier}`);
        }
        return verifier;
      });
      await artifact.evaluate();
      return artifact.namespace;
    },
  });
}
