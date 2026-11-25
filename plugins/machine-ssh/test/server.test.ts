import type { MachineBootstrapApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { Inspection } from "../contract.js";
import plugin from "../server.js";
import { AGENT_TRUST_REFUSAL } from "../server/provider.js";
import type { ResolvedTarget } from "../target.js";

const FINGERPRINT = `SHA256:${"k".repeat(43)}`;

const resolved: ResolvedTarget = {
  user: "dev",
  hostname: "10.0.0.5",
  port: 22,
  proxyJump: null,
  knownHostsName: "10.0.0.5",
  strictHostKeyChecking: false,
};

function inspection(
  state: Inspection["hostKey"]["state"],
  nodeVersion = "v22.23.4",
): Inspection {
  return {
    resolved,
    hostKey: { state, fingerprint: FINGERPRINT, keyType: "ED25519" },
    message: null,
    facts:
      state === "trusted"
        ? {
            os: "Linux",
            arch: "x86_64",
            user: "dev",
            root: false,
            node: "/usr/local/bin/node",
            nodeVersion,
            npm: true,
            curl: true,
            systemd: true,
            container: false,
            linger: false,
            routes: [{ url: "https://bb.example.test", status: 200 }],
            installs: [],
          }
        : null,
  };
}

interface Scenario {
  trusted?: boolean;
  nodeVersion?: string;
  viaConnected?: boolean;
  existingResource?: unknown;
  existingPhase?: "creating";
  uninstallError?: string;
  lingerExitCode?: number;
}

async function setup(scenario: Scenario = {}) {
  let trusted = scenario.trusted ?? false;
  const via = makeHostResponse({
    id: "host_via",
    name: "desk",
    status: scenario.viaConnected === false ? "disconnected" : "connected",
  });
  const existing = makeHostResponse({
    id: "host_existing",
    name: "build-box",
    machineProviderId: "ssh",
  });
  const hosts =
    scenario.existingResource === undefined ? [via] : [via, existing];
  const resources = new Map<string, unknown>();
  if (scenario.existingResource !== undefined) {
    resources.set("host_existing", scenario.existingResource);
    if (scenario.existingPhase !== undefined)
      existing.lifecycle = {
        ...existing.lifecycle,
        phase: scenario.existingPhase,
      };
  }
  const output: string[] = [];
  const bootstrap = vi.fn<MachineBootstrapApi["bootstrap"]>(async (request) => {
    await request.executor.exec({
      command: ["true"],
      stdin: "bundle",
      timeoutMs: 1_000,
      signal: request.signal,
      onOutput: (chunk) => output.push(chunk),
    });
    return { hostId: "host_new" };
  });
  const uninstall = vi.fn<MachineBootstrapApi["uninstall"]>(async () => {
    if (scenario.uninstallError !== undefined)
      throw new Error(scenario.uninstallError);
  });
  const create = vi.fn(async () =>
    makeHostResponse({ id: "host_new", name: "build-box" }),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb--machine-ssh",
    machineBootstrap: { bootstrap, uninstall },
    machineResource: async (hostId) => (resources.get(hostId) ?? null) as never,
    sdk: {
      hosts: {
        get: async ({ hostId }) => {
          const host = hosts.find((entry) => entry.id === hostId);
          if (host === undefined) throw new Error("Host not found");
          return {
            ...host,
            connectMachineId: null,
            threadStorageRootPath: null,
          };
        },
        list: async (args) =>
          hosts.filter(
            (host) =>
              args?.includeCreating === true ||
              host.lifecycle.phase !== "creating",
          ),
        experimental_create: create,
      },
      system: {
        config: async () =>
          ({
            primaryHostId: "host_via",
            serverAccess: {
              providers: [
                {
                  id: "direct",
                  displayName: "Manual",
                  routeKind: "custom",
                  availability: { status: "available" },
                  urls: ["https://bb.example.test"],
                },
              ],
            },
          }) as never,
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      if (method === "resolve") return { resolved, knownHost: trusted };
      if (method === "inspect")
        return inspection(
          trusted ? "trusted" : "unknown",
          scenario.nodeVersion,
        );
      if (method === "trust") {
        trusted = true;
        return { pinnedKey: "10.0.0.5 ssh-ed25519 AAAA" };
      }
      if (method === "forget") {
        if (scenario.viaConnected === false)
          throw new Error("Machine is offline");
        return { removed: true };
      }
      if (method === "exec") {
        const { executionId, command } = input as {
          executionId: string;
          command: string[];
        };
        if (command[0] === "loginctl")
          return { exitCode: scenario.lingerExitCode ?? 0 };
        await harness.behavior.experimental_emitHostSignal(hostId, "output", {
          executionId,
          chunk: "installing\n",
        });
        return { exitCode: 0 };
      }
      throw new Error(`Unexpected host call ${method}`);
    },
  });
  plugin(bb);
  const provider =
    harness.inspection.registrations.machineProviders.get("ssh")!;
  const checkpoints: unknown[] = [];
  const createContext = (inputs: Record<string, unknown>, key: string) => ({
    inputs: provider.inputs!["~standard"].validate(inputs),
    key,
    attempt: 1,
    checkpoint: async (resource: unknown) => {
      checkpoints.push(resource);
      const id = `host_${key}`;
      if (!resources.has(id)) {
        const creating = makeHostResponse({
          id,
          name: `SSH ${key}`,
          machineProviderId: "ssh",
        });
        creating.lifecycle = { ...creating.lifecycle, phase: "creating" };
        hosts.push(creating);
      }
      resources.set(id, resource);
    },
    report: { step: vi.fn(), log: vi.fn() },
    signal: new AbortController().signal,
  });
  async function runCreate(inputs: Record<string, unknown>, key = "launch") {
    const context = createContext(inputs, key);
    const parsed = await context.inputs;
    if ("issues" in parsed && parsed.issues !== undefined)
      throw new Error("invalid inputs");
    return provider.create({ ...context, inputs: parsed.value as never });
  }
  return {
    harness,
    provider,
    bootstrap,
    uninstall,
    create,
    checkpoints,
    output,
    runCreate,
    calls: () =>
      harness.inspection.experimental_hostRpcCalls.map((call) => call.method),
    execCommands: () =>
      harness.inspection.experimental_hostRpcCalls
        .filter((call) => call.method === "exec")
        .map((call) => (call.input as { command: string[] }).command),
  };
}

const inputs = { via: "host_via", destination: "dev@10.0.0.5" };

const existingResource = {
  via: "host_via",
  target: { destination: "build", port: null, identityFile: null },
  resolved,
  keepRunning: true,
  pinnedKey: "10.0.0.5 ssh-ed25519 AAAA",
  enabledLinger: false,
  launchKey: "earlier",
};

describe("ssh machine provider", () => {
  it.each([
    {
      name: "an agent confirming a fingerprint",
      scenario: { trusted: true },
      inputs: { ...inputs, hostKey: FINGERPRINT },
      thread: "thr_agent",
      message: AGENT_TRUST_REFUSAL,
    },
    {
      name: "an agent adding an untrusted host",
      scenario: { trusted: false },
      inputs,
      thread: "thr_agent",
      message: AGENT_TRUST_REFUSAL,
    },
    {
      name: "an offline Connect from machine",
      scenario: { viaConnected: false },
      inputs,
      thread: null,
      message: "desk is offline",
    },
    {
      name: "a computer that is already a machine",
      scenario: { existingResource },
      inputs,
      thread: null,
      message:
        "dev@10.0.0.5:22 is already the machine build-box. Use Reconnect on that machine instead.",
    },
  ])("refuses $name", async ({ scenario, inputs, thread, message }) => {
    const h = await setup(scenario);
    await expect(
      h.provider.validate!({
        inputs: { ...inputs, keepRunning: true },
        requestedByThreadId: thread,
      }),
    ).resolves.toEqual({ action: "refuse", message });
  });

  it("refuses a computer that another add is still working on", async () => {
    const h = await setup({
      trusted: true,
      existingResource,
      existingPhase: "creating",
    });
    await expect(
      h.provider.validate!({
        inputs: { ...inputs, keepRunning: true },
        requestedByThreadId: null,
      }),
    ).resolves.toEqual({
      action: "refuse",
      message:
        "bb is already adding dev@10.0.0.5:22 as build-box. Wait for that setup to finish, or remove that machine.",
    });
  });

  it("installs once when two adds of one computer run together", async () => {
    const h = await setup({ trusted: true });
    const results = await Promise.all([
      h.runCreate(inputs, "first"),
      h.runCreate(inputs, "second"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "created",
      "failed",
    ]);
    expect(h.bootstrap).toHaveBeenCalledOnce();
  });

  it("lets a create that resumes pass its own record", async () => {
    const h = await setup({
      trusted: true,
      existingResource: { ...existingResource, launchKey: "launch" },
      existingPhase: "creating",
    });
    await expect(h.runCreate(inputs, "launch")).resolves.toMatchObject({
      status: "created",
    });
  });

  it("lets an agent add an already trusted host", async () => {
    const h = await setup({ trusted: true });
    await expect(
      h.provider.validate!({
        inputs: { ...inputs, keepRunning: true },
        requestedByThreadId: "thr_agent",
      }),
    ).resolves.toEqual({ action: "accept" });
  });

  it("never trusts a new key without the confirmed fingerprint", async () => {
    const h = await setup();
    await expect(h.runCreate(inputs)).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining(FINGERPRINT),
    });
    await expect(
      h.runCreate({ ...inputs, hostKey: `SHA256:${"z".repeat(43)}` }),
    ).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("not the confirmed"),
    });
    expect(h.calls()).not.toContain("trust");
    expect(h.bootstrap).not.toHaveBeenCalled();
  });

  it("trusts the confirmed key, installs over ssh on the chosen route and names the machine", async () => {
    const h = await setup();
    const result = await h.runCreate({
      ...inputs,
      hostKey: FINGERPRINT,
      access: "direct",
      keepRunning: false,
    });
    expect(result).toEqual({
      status: "created",
      name: "10.0.0.5",
      resource: {
        via: "host_via",
        target: {
          destination: "dev@10.0.0.5",
          port: null,
          identityFile: null,
        },
        resolved,
        keepRunning: false,
        pinnedKey: "10.0.0.5 ssh-ed25519 AAAA",
        enabledLinger: false,
        launchKey: "launch",
      },
    });
    expect(h.bootstrap.mock.calls[0]![0]).toMatchObject({
      key: "launch",
      access: { providerId: "direct" },
    });
    expect(h.output).toEqual(["installing\n"]);
    expect(h.execCommands()).toEqual([["true"]]);
    expect(
      h.harness.inspection.experimental_hostRpcCalls.find(
        (call) => call.method === "exec",
      )?.input,
    ).toMatchObject({ linger: false, stdin: "bundle" });
    expect(h.checkpoints).toHaveLength(2);
  });

  it.each([
    { lingerExitCode: 0, status: "created", installs: 1 },
    { lingerExitCode: 1, status: "failed", installs: 0 },
  ])(
    "turns on lingering before installing and stops when it cannot ($lingerExitCode)",
    async ({ lingerExitCode, status, installs }) => {
      const h = await setup({ trusted: true, lingerExitCode });
      const result = await h.runCreate(inputs);
      expect(result.status).toBe(status);
      if (result.status === "created")
        expect(result.resource).toMatchObject({ enabledLinger: true });
      if (result.status === "failed")
        expect(result.message).toContain("sudo loginctl enable-linger dev");
      expect(h.execCommands()[0]).toEqual([
        "loginctl",
        "--no-ask-password",
        "enable-linger",
      ]);
      expect(h.bootstrap).toHaveBeenCalledTimes(installs);
    },
  );

  it("stops before installing when the computer lacks a supported Node", async () => {
    const h = await setup({ trusted: true, nodeVersion: "v20.19.2" });
    await expect(h.runCreate(inputs)).resolves.toEqual({
      status: "failed",
      message:
        "Node.js 22.19 or newer is required on dev@10.0.0.5; it has v20.19.2 at /usr/local/bin/node. Upgrade it, then try again.",
    });
    expect(h.bootstrap).not.toHaveBeenCalled();
  });

  it("says which machine is offline instead of reconnecting", async () => {
    const h = await setup({ viaConnected: false });
    await expect(
      h.provider.executor!({
        hostId: "host_new",
        resource: existingResource,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("desk is offline, so bb cannot reach build over SSH");
  });

  const remove = (
    h: Awaited<ReturnType<typeof setup>>,
    resource: typeof existingResource,
  ) =>
    h.provider.remove({
      hostId: "host_new",
      resource,
      report: { step: vi.fn(), log: vi.fn() },
      signal: new AbortController().signal,
    });

  it("uninstalls and forgets the pinned key", async () => {
    const h = await setup({ trusted: true });
    await expect(remove(h, existingResource)).resolves.toEqual({
      status: "removed",
    });
    expect(h.uninstall).toHaveBeenCalledOnce();
    expect(h.calls()).toContain("forget");
  });

  it.each([
    {
      name: "the daemon an unreachable computer keeps",
      scenario: {
        uninstallError:
          "Machine uninstall command failed:\nssh could not reach the computer.\nssh: connect to host 10.0.0.5 port 22: No route to host\n",
      },
      enabledLinger: true,
      parts: [
        "The bb daemon may still run on build. To remove it, download install.sh from your bb server and run there: sh install.sh --uninstall --host-id host_new",
        "sudo loginctl disable-linger dev",
        "Uninstall failed: ssh: connect to host 10.0.0.5 port 22: No route to host",
      ],
    },
    {
      name: "the lingering that bb turned on",
      scenario: {},
      enabledLinger: true,
      parts: [
        "bb turned on lingering for dev on build",
        "sudo loginctl disable-linger dev",
      ],
    },
    {
      name: "the key an offline Connect from machine keeps",
      scenario: { viaConnected: false },
      enabledLinger: false,
      parts: [
        "The bb daemon may still run on build",
        "bb could not remove the trusted host key of build",
        "Uninstall failed: desk is offline",
      ],
    },
  ])(
    "removes the machine and reports $name",
    async ({ scenario, enabledLinger, parts }) => {
      const h = await setup({ trusted: true, ...scenario });
      const result = await remove(h, { ...existingResource, enabledLinger });
      expect(result.status).toBe("removed");
      const warning = result.status === "removed" ? result.warning : "";
      for (const part of parts) expect(warning).toContain(part);
      expect(warning?.startsWith(parts[0]!)).toBe(true);
    },
  );

  it("keeps a pinned key another machine still uses", async () => {
    const h = await setup({ trusted: true, existingResource });
    await h.provider.remove({
      hostId: "host_new",
      resource: existingResource,
      report: { step: vi.fn(), log: vi.fn() },
      signal: new AbortController().signal,
    });
    expect(h.calls()).not.toContain("forget");
  });
});

describe("bb ssh", () => {
  it("refuses to trust a host key from an agent thread", async () => {
    const h = await setup();
    const withKey = await h.harness.behavior.runCli(
      ["add", "dev@10.0.0.5", "--via", "desk", "--host-key", FINGERPRINT],
      { threadId: "thr_agent" },
    );
    const withoutKey = await h.harness.behavior.runCli(
      ["add", "dev@10.0.0.5", "--via", "desk"],
      { threadId: "thr_agent" },
    );
    for (const result of [withKey, withoutKey]) {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(AGENT_TRUST_REFUSAL);
    }
    expect(h.create).not.toHaveBeenCalled();
    expect(h.calls()).not.toContain("trust");
  });

  it("asks a person for the fingerprint, then creates the machine with it", async () => {
    const h = await setup();
    const first = await h.harness.behavior.runCli([
      "add",
      "dev@10.0.0.5",
      "--via",
      "desk",
    ]);
    expect(first.exitCode).not.toBe(0);
    expect(first.stderr).toContain(`--host-key ${FINGERPRINT}`);

    const second = await h.harness.behavior.runCli([
      "add",
      "dev@10.0.0.5",
      "--via",
      "host_via",
      "--host-key",
      FINGERPRINT,
      "--name",
      "Build",
      "--no-keep-running",
    ]);
    expect(second).toMatchObject({ exitCode: 0 });
    expect(h.create).toHaveBeenCalledWith({
      machineProviderId: "ssh",
      inputs: {
        via: "host_via",
        destination: "dev@10.0.0.5",
        hostKey: FINGERPRINT,
        name: "Build",
        keepRunning: false,
      },
      wait: true,
    });
  });

  it("probes without trusting anything", async () => {
    const h = await setup();
    const result = await h.harness.behavior.runCli([
      "probe",
      "dev@10.0.0.5",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toMatchObject({
      via: "host_via",
      inspection: { hostKey: { state: "unknown", fingerprint: FINGERPRINT } },
    });
    expect(h.calls()).toEqual(["inspect"]);
  });
});
