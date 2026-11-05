import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  active: true,
  releaseSuspension: undefined as (() => void) | undefined,
  startupFailure: undefined as unknown,
  diagnosticWrites: 0,
  runtimeImports: 0,
  startupRoots: [] as object[],
  registration: {
    cohort: "NOT_ESTABLISHED" as const,
    assertBootstrapActive() {
      if (!state.active) throw new Error("revoked original registration");
    },
    revoke() { state.active = false; },
  },
}));

vi.mock("node:url", () => ({ fileURLToPath: () => process.argv[1] }));
vi.mock("node:fs", () => ({
  existsSync: () => { throw new Error("Unexpected native filesystem access in entry control test."); },
}));
vi.mock("@bb/config/managed-process-registration", () => ({
  internal_DO_NOT_USE_registerManagedProcess: async () => state.registration,
}));
vi.mock("@bb/config/file-lock", () => ({
  internal_DO_NOT_USE_assertManagedRootAdmission: () => undefined,
}));
vi.mock("@bb/config/host-daemon", () => ({
  loadHostDaemonStartConfig: () => ({ dataDir: "/never-accessed" }),
}));
vi.mock("@bb/config/host-daemon-entrypoint", () => ({ loadHostDaemonEntrypointConfig: () => ({ BB_BRIDGE_DIR: "/never-accessed" }) }));
vi.mock("@bb/process-utils", () => ({
  installSafeProcessDiagnostics: () => undefined,
  installSocketTypeOfServiceGuard: () => undefined,
  writeSafeProcessDiagnosticReport: () => { state.diagnosticWrites += 1; },
}));
vi.mock("./suspension-marker.js", () => ({
  hasMachineSuspensionMarker: () => new Promise<boolean>((resolve) => {
    state.releaseSuspension = () => resolve(false);
  }),
}));
vi.mock("./start-host-daemon.js", () => {
  state.runtimeImports += 1;
  return {
    startHostDaemon: async (options: { managedRoot: object }) => {
      state.startupRoots.push(options.managedRoot);
      throw state.startupFailure;
    },
  };
});

describe("selected daemon entry control sequencing only", () => {
  beforeEach(() => {
    vi.resetModules();
    state.active = true;
    state.releaseSuspension = undefined;
    state.startupFailure = undefined;
    state.diagnosticWrites = 0;
    state.runtimeImports = 0;
    state.startupRoots = [];
  });

  it("does not import runtime after revocation during the suspension await", async () => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    process.argv = [...originalArgv, "--bb-managed-bootstrap"];
    try {
      await import("./index.js");
      await vi.waitFor(() => expect(state.releaseSuspension).toBeTypeOf("function"));
      state.registration.revoke();
      state.releaseSuspension?.();
      await vi.waitFor(() => expect(stderr).toHaveBeenCalled());
      expect(state.runtimeImports).toBe(0);
      expect(state.startupRoots).toEqual([]);
      expect(state.diagnosticWrites).toBe(0);
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      stderr.mockRestore();
    }
  });

  it("passes the same registration and avoids diagnostic writes on opaque runtime failure", async () => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    process.argv = [...originalArgv, "--bb-managed-bootstrap"];
    try {
      await import("./index.js");
      await vi.waitFor(() => expect(state.releaseSuspension).toBeTypeOf("function"));
      state.releaseSuspension?.();
      await vi.waitFor(() => expect(stderr).toHaveBeenCalled());
      expect(state.startupRoots).toHaveLength(1);
      expect(state.startupRoots[0]).toBe(state.registration);
      expect(state.diagnosticWrites).toBe(0);
      expect(stderr).toHaveBeenCalledWith("undefined\n");
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      stderr.mockRestore();
    }
  });
});
