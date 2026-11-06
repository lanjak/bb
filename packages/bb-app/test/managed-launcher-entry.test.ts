import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stages: [] as string[],
  controller: undefined as undefined | { snapshot(): { cohort: string; predecessor: string; attached: number } },
  forbidden: vi.fn(() => { throw new Error("Unexpected production effect in selected entry control."); }),
  closedModule(name: string, values: Record<string, unknown> = {}) {
    return new Proxy(values, {
      get(target, key) {
        if (key === "then") return undefined;
        if (key === "__esModule") return true;
        if (typeof key === "string" && Object.hasOwn(target, key)) return target[key];
        return state.forbidden;
      },
    });
  },
}));

vi.mock("@bb/process-utils", () => state.closedModule("process-utils", { hostToolchain: { refresh: state.forbidden } }));
vi.mock("node:fs", () => state.closedModule("fs"));
vi.mock("node:fs/promises", () => state.closedModule("fs/promises"));
vi.mock("node:os", () => ({ homedir: () => "/entry-control-home" }));
vi.mock("../src/logged-process.js", () => ({ spawnLoggedProcess: state.forbidden }));
vi.mock("@bb/config/file-lock", async () => {
  const owner = await vi.importActual<typeof import("@bb/config/internal-managed-root-admission")>("@bb/config/internal-managed-root-admission");
  return {
    ...owner,
    internal_DO_NOT_USE_enrollManagedRoot(root: object) {
      state.stages.push("enroll");
      return owner.internal_DO_NOT_USE_enrollManagedRoot(root);
    },
    internal_DO_NOT_USE_beginManagedRootEffect(effect: string) {
      state.stages.push(`deny:${effect}`);
      return owner.internal_DO_NOT_USE_beginManagedRootEffect(effect);
    },
  };
});
vi.mock("../src/managed-cohort-controller.js", async () => {
  const actual = await vi.importActual<typeof import("../src/managed-cohort-controller.js")>("../src/managed-cohort-controller.js");
  return {
    createManagedCohortController(...args: Parameters<typeof actual.createManagedCohortController>) {
      expect(args[0]).toEqual(["server", "host-daemon"]);
      expect(args[1]).toBeUndefined();
      const original = actual.createManagedCohortController(...args);
      state.controller = original;
      return {
        ...original,
        async continueFixedBootstrap() {
          state.stages.push("fixed:server,host-daemon");
          return original.continueFixedBootstrap();
        },
      };
    },
  };
});
vi.mock("@bb/config/runtime", () => state.closedModule("runtime", {
  resolveProdDataDir: () => "/entry-control-root",
  resolveConfiguredDataDir: () => "/entry-control-root",
}));
vi.mock("@bb/config/bb-app-managed-config", () => state.closedModule("managed-config", { BB_APP_MANAGED_CONFIG_KEYS: [] }));
vi.mock("@bb/config/desktop-app-update", () => state.closedModule("desktop-update"));
vi.mock("../src/moved-responder.js", () => state.closedModule("moved-responder"));
vi.mock("@bb/config/managed-json-file", () => state.closedModule("managed-json"));
vi.mock("@bb/config/app-runtime-file", () => state.closedModule("app-runtime"));
vi.mock("@bb/config/verified-process-stop", () => state.closedModule("verified-stop"));
vi.mock("@bb/config/machine-service", () => state.closedModule("machine-service"));
vi.mock("@bb/config/child-process-exit", () => state.closedModule("child-exit"));
vi.mock("@bb/config/app-surface", () => state.closedModule("app-surface"));
vi.mock("@bb/config/client-config", () => state.closedModule("client-config"));
vi.mock("@bb/config/log-level", () => state.closedModule("log-level"));
vi.mock("@bb/config/public-url", () => state.closedModule("public-url"));
vi.mock("@bb/config/server", () => state.closedModule("server"));
vi.mock("@bb/config/strings", () => state.closedModule("strings"));
vi.mock("@bb/server-archive", () => state.closedModule("server-archive"));
vi.mock("@bb/config/app-update", () => state.closedModule("app-update"));
vi.mock("@bb/config/app-install", () => state.closedModule("app-install"));
vi.mock("@bb/config/cli-command", () => state.closedModule("cli-command"));
vi.mock("../src/app-install.js", () => state.closedModule("app-install-local"));
vi.mock("../src/cli-launcher.js", () => state.closedModule("cli-launcher"));
vi.mock("../src/app-update/launcher-controller.js", () => state.closedModule("update-controller"));
vi.mock("../src/app-update/npm-shim.js", () => state.closedModule("npm-shim"));
vi.mock("../src/app-update/run-command.js", () => state.closedModule("run-command"));
vi.mock("../src/app-update/source-checkout.js", () => state.closedModule("source-checkout"));
vi.mock("../src/app-update/source-shim.js", () => state.closedModule("source-shim"));
vi.mock("../src/app-update/shim-support.js", () => state.closedModule("shim-support"));
vi.mock("../src/launcher-output.js", () => state.closedModule("launcher-output"));

it("runs only the fixed control continuation after enrollment and denies physical issuance with unknown predecessor", async () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const arbitraryEntry = vi.fn(async () => undefined);
  process.argv = [...argv, "--bb-managed-bootstrap"];
  try {
    const { runLauncherEntry } = await import("../src/launcher.js");
    runLauncherEntry(arbitraryEntry);
    await vi.waitFor(() => expect(stderr).toHaveBeenCalled());
    expect(state.stages).toEqual(["enroll", "fixed:server,host-daemon", "deny:fixed server bootstrap spawn"]);
    expect(arbitraryEntry).not.toHaveBeenCalled();
    expect(state.forbidden).not.toHaveBeenCalled();
    expect(state.controller?.snapshot()).toMatchObject({ cohort: "NOT_ESTABLISHED", predecessor: "UNKNOWN", attached: 0 });
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    stderr.mockRestore();
  }
});
