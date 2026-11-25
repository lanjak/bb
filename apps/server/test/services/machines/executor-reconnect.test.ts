import {
  getHost,
  hosts,
  updateHost,
  upsertHostServerAccessGrant,
} from "@bb/db";
import { MACHINE_RECONNECT_FAILURE_PREFIX } from "@bb/server-contract";
import { createDeferredPromise } from "@bb/test-helpers";
import type {
  MachineExecutor,
  PluginMachineProviderDeclaration,
} from "@get-bb/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestMachineRemoval,
  sweepProviderMachine,
} from "../../../src/services/machines/provider-orchestration.js";
import {
  setPluginMachineProviderBridge,
  type PluginMachineProviderRecord,
} from "../../../src/services/plugins/plugin-machine-provider-registry.js";
import { setServerAccessBridge } from "../../../src/services/plugins/plugin-server-access-registry.js";
import { readJson } from "../../helpers/json.js";
import { installMachineProvider } from "../../helpers/machine-provider.js";
import { seedHost, seedPrimaryHost, seedSession } from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const API = "/api/v1";

afterEach(() => {
  vi.restoreAllMocks();
  setPluginMachineProviderBridge(undefined);
  setServerAccessBridge(undefined);
});

function installRelayAccess() {
  const release = vi.fn(async () => {});
  setServerAccessBridge({
    list: () => [
      {
        pluginId: "relay-plugin",
        provider: {
          id: "relay",
          displayName: "Relay",
          description: "Test relay",
          routeKind: "relay" as const,
          availability: () => ({ status: "available" as const }),
          acquire: async ({ hostId }: { hostId: string }) => ({
            id: hostId,
            serverUrl: "https://relay.example.com",
            headers: { "x-access-token": "relay-access-token" },
          }),
          release,
        },
      },
    ],
    invoke: async (_id, run) => run(),
  });
  return { release };
}

function seedOfflineMachine(
  harness: TestAppHarness,
  machineProviderId: string,
) {
  const host = seedHost(harness.deps, { id: "host_remote" });
  const session = seedSession(harness.deps, host.id);
  harness.hub.unregisterDaemon(session.id);
  harness.db
    .update(hosts)
    .set({
      machineProviderId,
      resource: { target: "build-box" },
      phase: "active",
      serverAccessProviderId: "relay",
    })
    .where(eq(hosts.id, host.id))
    .run();
  upsertHostServerAccessGrant(harness.db, {
    hostId: host.id,
    providerId: "relay",
    grantId: host.id,
  });
  return host.id;
}

function connectMachine(harness: TestAppHarness, hostId: string) {
  const session = seedSession(harness.deps, hostId, {
    instanceId: "instance-reconnected",
  });
  harness.hub.registerDaemon(session.id, hostId, {
    close: vi.fn(),
    send: vi.fn(),
  });
}

type ExecRequest = Parameters<MachineExecutor["exec"]>[0];

function recordingExecutor(
  handle: (request: ExecRequest) => Promise<{ exitCode: number }>,
) {
  const requests: ExecRequest[] = [];
  const executor: MachineExecutor = {
    async exec(request) {
      requests.push(request);
      return handle(request);
    },
  };
  return { executor, requests };
}

function reconnect(
  harness: TestAppHarness,
  hostId: string,
  query = "",
  headers: Record<string, string> = {},
) {
  return harness.app.request(
    `${API}/hosts/${hostId}/reconnect-commands${query}`,
    { method: "POST", headers },
  );
}

const providerKinds: Array<{
  name: string;
  overrides: Partial<PluginMachineProviderDeclaration>;
  readyMode: "command" | "operation";
}> = [
  {
    name: "a provider without an executor",
    overrides: {},
    readyMode: "command",
  },
  {
    name: "a provider with an executor",
    overrides: {
      executor: () => ({ exec: () => new Promise<never>(() => {}) }),
    },
    readyMode: "operation",
  },
];

describe.each(providerKinds)("reconnect through $name", (kind) => {
  it.each([
    {
      case: "an offline machine",
      arrange: () => {},
      status: 201,
      body: { mode: kind.readyMode },
    },
    {
      case: "a connected machine",
      arrange: (harness: TestAppHarness, hostId: string) =>
        connectMachine(harness, hostId),
      status: 409,
      body: { code: "machine_reconnect_not_needed" },
    },
    {
      case: "the server's own machine",
      arrange: (harness: TestAppHarness, hostId: string) =>
        seedPrimaryHost(harness.deps, hostId),
      status: 409,
      body: { code: "machine_reconnect_unavailable" },
    },
    {
      case: "a suspended machine",
      arrange: (harness: TestAppHarness, hostId: string) => {
        updateHost(harness.db, harness.hub, hostId, { phase: "suspended" });
      },
      status: 409,
      body: { code: "machine_reconnect_unavailable" },
    },
  ])("answers $case", async (scenario) => {
    await withTestHarness(async (harness) => {
      installRelayAccess();
      installMachineProvider(kind.overrides);
      const hostId = seedOfflineMachine(harness, "test-machine");
      scenario.arrange(harness, hostId);

      const response = await reconnect(harness, hostId);

      expect(response.status).toBe(scenario.status);
      expect(await readJson(response)).toMatchObject(scenario.body);
      requestMachineRemoval(harness.deps, hostId);
      await sweepProviderMachine(harness.deps, hostId);
    });
  });

  it("returns the manual command on request", async () => {
    await withTestHarness(async (harness) => {
      installRelayAccess();
      installMachineProvider(kind.overrides);
      const hostId = seedOfflineMachine(harness, "test-machine");

      const response = await reconnect(harness, hostId, "?printCommand=true");

      expect(response.status).toBe(201);
      expect(await readJson(response)).toMatchObject({
        mode: "command",
        unavailableReason: null,
        command: expect.stringContaining(
          "https://relay.example.com/install.sh",
        ),
      });
    });
  });

  it("refuses machine credentials", async () => {
    await withTestHarness(async (harness) => {
      installRelayAccess();
      installMachineProvider(kind.overrides);
      const hostId = seedOfflineMachine(harness, "test-machine");

      const response = await reconnect(harness, hostId, "", {
        "x-bb-gate-auth": "machine",
      });

      expect(response.status).toBe(403);
      expect(getHost(harness.db, hostId)?.machineOperationId).toBeNull();
    });
  });
});

describe("executor reconnect", () => {
  it("runs the installer through the executor and finishes when the daemon connects", async () => {
    await withTestHarness(async (harness) => {
      const access = installRelayAccess();
      let releasedBeforeRedemption = -1;
      let redeemed = "";
      const { executor, requests } = recordingExecutor(async (request) => {
        if (request.command[0] === "true") return { exitCode: 0 };
        releasedBeforeRedemption = access.release.mock.calls.length;
        const script = await harness.app.request("/install.sh", {
          headers: { "X-BB-Enrollment": request.stdin },
        });
        redeemed = await script.text();
        request.onOutput(
          `\u001b[32mInstalling\u001b[0m with ${request.stdin}\n`,
        );
        connectMachine(harness, "host_remote");
        return { exitCode: 0 };
      });
      const resources: unknown[] = [];
      installMachineProvider({
        executor: ({ resource }) => {
          resources.push(resource);
          return executor;
        },
      });
      const hostId = seedOfflineMachine(harness, "test-machine");

      const response = await reconnect(harness, hostId);
      expect(await readJson(response)).toEqual({
        mode: "operation",
        hostId,
        progress: "in-progress",
      });

      await expect
        .poll(() => getHost(harness.db, hostId)?.machineOperationId)
        .toBeNull();
      const host = getHost(harness.db, hostId)!;
      expect(host.statusMessage).toBeNull();
      expect(host.phase).toBe("active");
      expect(resources).toEqual([{ target: "build-box" }]);
      expect(requests.map((request) => request.command[0])).toEqual([
        "true",
        "sh",
      ]);
      const { command, stdin: credential } = requests[1]!;
      expect(command.at(-1)).toBe("https://relay.example.com/install.sh");
      expect(command.join(" ")).not.toContain(credential);
      expect(releasedBeforeRedemption).toBe(0);
      expect(access.release).toHaveBeenCalledOnce();
      expect(redeemed).toContain('"reconnect":true');
      expect(redeemed).toContain(`"dataDir":"/tmp/bb-host-data/${hostId}"`);
      expect(redeemed).toContain("relay-access-token");
      expect(host.pendingLog).toContain("Installing with [redacted]");
      expect(host.pendingLog).not.toContain(credential);
      expect(host.pendingLog).not.toContain("\u001b");
    });
  });

  it("keeps the machine's access when the installer fails before it starts", async () => {
    await withTestHarness(async (harness) => {
      const access = installRelayAccess();
      const { executor, requests } = recordingExecutor(async (request) => {
        if (request.command[0] === "true") return { exitCode: 0 };
        request.onOutput("curl: (22) The requested URL returned error: 502\n");
        return { exitCode: 22 };
      });
      installMachineProvider({ executor: () => executor });
      const hostId = seedOfflineMachine(harness, "test-machine");

      await reconnect(harness, hostId);

      await expect
        .poll(() => getHost(harness.db, hostId)?.machineOperationId)
        .toBeNull();
      expect(getHost(harness.db, hostId)?.statusMessage).toBe(
        `${MACHINE_RECONNECT_FAILURE_PREFIX} The machine installer failed`,
      );
      expect(access.release).not.toHaveBeenCalled();
      const reused = await harness.app.request("/install.sh", {
        headers: { "X-BB-Enrollment": requests[1]!.stdin },
      });
      expect(reused.status).toBe(403);
    });
  });

  it("keeps the machine's access when the computer cannot be reached", async () => {
    await withTestHarness(async (harness) => {
      const access = installRelayAccess();
      const { executor, requests } = recordingExecutor(async (request) => {
        request.onOutput(
          "ssh: connect to host build-box: Connection refused\n",
        );
        return { exitCode: 255 };
      });
      installMachineProvider({ executor: () => executor });
      const hostId = seedOfflineMachine(harness, "test-machine");

      await reconnect(harness, hostId);

      await expect
        .poll(() => getHost(harness.db, hostId)?.machineOperationId)
        .toBeNull();
      const host = getHost(harness.db, hostId)!;
      expect(host.statusMessage).toBe(
        `${MACHINE_RECONNECT_FAILURE_PREFIX} Could not connect to the computer`,
      );
      expect(host.pendingLog).toContain("Connection refused");
      expect(host.phase).toBe("active");
      expect(requests).toHaveLength(1);
      expect(access.release).not.toHaveBeenCalled();
    });
  });

  it("offers the manual command with the reason when the executor is unavailable", async () => {
    await withTestHarness(async (harness) => {
      installRelayAccess();
      installMachineProvider({
        executor: () => {
          throw new Error("laptop is offline");
        },
      });
      const hostId = seedOfflineMachine(harness, "test-machine");

      const response = await reconnect(harness, hostId);

      expect(await readJson(response)).toMatchObject({
        mode: "command",
        unavailableReason: expect.stringContaining("laptop is offline"),
      });
      expect(getHost(harness.db, hostId)?.machineOperationId).toBeNull();
    });
  });

  it("joins a running reconnect, then stops it for a manual command", async () => {
    await withTestHarness(async (harness) => {
      installRelayAccess();
      const aborted = createDeferredPromise<void>();
      const { executor, requests } = recordingExecutor(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              aborted.resolve();
              reject(request.signal.reason);
            });
          }),
      );
      const factory = vi.fn(() => executor);
      installMachineProvider({ executor: factory });
      const hostId = seedOfflineMachine(harness, "test-machine");

      const [first, second] = await Promise.all([
        reconnect(harness, hostId),
        reconnect(harness, hostId),
      ]);
      expect(await readJson(first)).toMatchObject({ mode: "operation" });
      expect(await readJson(second)).toMatchObject({ mode: "operation" });
      expect(factory).toHaveBeenCalledOnce();
      await expect.poll(() => requests.length).toBe(1);

      const manual = await reconnect(harness, hostId, "?printCommand=true");
      await aborted.promise;
      expect(await readJson(manual)).toMatchObject({ mode: "command" });
      expect(getHost(harness.db, hostId)).toMatchObject({
        machineOperationId: null,
        statusMessage: null,
      });
    });
  });

  it("stops a running reconnect when the machine is removed", async () => {
    await withTestHarness(async (harness) => {
      installRelayAccess();
      let signal: AbortSignal | undefined;
      const { executor, requests } = recordingExecutor(
        (request) =>
          new Promise((_resolve, reject) => {
            signal = request.signal;
            request.signal.addEventListener("abort", () =>
              reject(request.signal.reason),
            );
          }),
      );
      const remove = vi.fn(async () => ({ status: "removed" as const }));
      installMachineProvider({ executor: () => executor, remove });
      const hostId = seedOfflineMachine(harness, "test-machine");
      await reconnect(harness, hostId);
      await expect.poll(() => requests.length).toBe(1);

      requestMachineRemoval(harness.deps, hostId);
      await sweepProviderMachine(harness.deps, hostId);

      expect(signal?.aborted).toBe(true);
      expect(remove).toHaveBeenCalledOnce();
      expect(getHost(harness.db, hostId)?.phase).toBe("destroyed");
    });
  });

  it("clears a reconnect claim left behind by a server restart", async () => {
    await withTestHarness(async (harness) => {
      installRelayAccess();
      const record: PluginMachineProviderRecord = installMachineProvider({
        executor: () => ({ exec: async () => ({ exitCode: 0 }) }),
      });
      const hostId = seedOfflineMachine(harness, record.provider.id);
      updateHost(harness.db, harness.hub, hostId, {
        machineOperationId: `${record.pluginId}:reconnect:interrupted`,
        statusMessage: "Running the machine installer",
      });

      await sweepProviderMachine(harness.deps, hostId);

      expect(getHost(harness.db, hostId)).toMatchObject({
        machineOperationId: null,
        phase: "active",
        statusMessage: expect.stringContaining(
          MACHINE_RECONNECT_FAILURE_PREFIX,
        ),
      });
    });
  });
});
