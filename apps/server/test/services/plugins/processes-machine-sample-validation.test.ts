import { describe, expect, it } from "vitest";
import {
  MAX_MACHINE_PATHS,
  selectMachinePaths,
  type PathEnvironment,
} from "bb-plugin-bb--processes/paths";
import { processesHostContract } from "bb-plugin-bb--processes/contract";
import { callPluginHostRpc } from "../../../src/services/plugins/plugin-host-rpc.js";
import { registerHostRpcResponder } from "../../helpers/host-rpc.js";
import { stubHostArtifact } from "../../helpers/provider-registry.js";
import { seedHostSession } from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

const SAMPLE = {
  platform: "linux",
  cpuPercent: 12,
  cpuCount: 8,
  loadAverage: null,
  memory: {
    totalBytes: 1,
    usedBytes: 1,
    source: "meminfo" as const,
    pressure: null,
  },
  disks: [],
  sampledAt: 1,
};

function environments(count: number): PathEnvironment[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/work/env-${index}`,
    status: index % 3 === 0 ? "destroyed" : "ready",
    hostLifecycle: "active",
    updatedAt: index,
    createdAt: index,
  }));
}

async function sampleMachine(paths: string[]) {
  return withTestHarness(async (harness) => {
    const { host, session } = seedHostSession(harness.deps);
    const seen: unknown[] = [];
    const responder = registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      handle: async (request) => {
        if (request.command.type !== "plugin.host.call")
          throw new Error(`Unexpected RPC ${request.command.type}`);
        seen.push(request.command.input);
        return { ok: true, result: { output: SAMPLE } };
      },
    });
    try {
      const result = await callPluginHostRpc(harness.deps, {
        pluginId: "bb--processes",
        contract: processesHostContract,
        method: "machine.sample",
        input: { paths },
        hostId: host.id,
        artifact: stubHostArtifact("bb--processes"),
      });
      return { result, seen };
    } finally {
      responder.unregister();
    }
  });
}

describe("the Processes plugin's machine read through the server's host input validation", () => {
  it("accepts the paths the plugin picks for a machine with more than 100 environments", async () => {
    const all = environments(134);
    expect(all.length).toBeGreaterThan(100);
    const paths = selectMachinePaths(all);
    expect(paths).toHaveLength(MAX_MACHINE_PATHS);
    const { result, seen } = await sampleMachine(paths);
    expect(result).toMatchObject({ cpuPercent: 12 });
    expect(seen).toEqual([{ paths }]);
    expect(paths[0]).toBe("/work/env-133");
  });

  it("refuses more paths than the contract allows, so the cap is the one the plugin sends within", async () => {
    const all = environments(134)
      .map((environment) => environment.path)
      .filter((path): path is string => path !== null);
    await expect(sampleMachine(all)).rejects.toThrow();
    await expect(
      sampleMachine(all.slice(0, MAX_MACHINE_PATHS)),
    ).resolves.toMatchObject({ result: { cpuPercent: 12 } });
  });
});
