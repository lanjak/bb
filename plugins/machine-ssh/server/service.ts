import { randomUUID } from "node:crypto";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type {
  CheckReport,
  ConnectionOptions,
  ListedConfigHost,
} from "../app-contract.js";
import { sshHostContract, sshHostSignals } from "../contract.js";
import {
  machineResourceSchema,
  sameResolvedTarget,
  type MachineResource,
  type ResolvedTarget,
  type SshTarget,
} from "../target.js";
import { PROVIDER_ID } from "../provider-id.js";
import { probeBlockers, probeNotes, type RouteOption } from "./checks.js";

const RESOLVE_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 90_000;
const INSPECT_TIMEOUT_MS = 4 * 60_000;
const MAX_CALL_TIMEOUT_MS = 30 * 60_000;
const CALL_MARGIN_MS = 30_000;
const MAX_ROUTE_URLS = 16;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSshService(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({
    contract: sshHostContract,
    experimental_signals: sshHostSignals,
  });
  const outputs = new Map<
    string,
    { hostId: string; write: (chunk: string) => void }
  >();
  host.experimental_onSignal("output", ({ hostId, payload }) => {
    const execution = outputs.get(payload.executionId);
    if (execution?.hostId === hostId) execution.write(payload.chunk);
  });

  async function machineName(hostId: string): Promise<string> {
    return (
      (await bb.sdk.hosts.get({ hostId }).catch(() => null))?.name ?? hostId
    );
  }

  async function requireVia(hostId: string) {
    const machine = await bb.sdk.hosts.get({ hostId }).catch(() => null);
    if (machine === null)
      throw new Error(`There is no machine ${hostId} to connect from`);
    if (machine.status !== "connected")
      throw new Error(`${machine.name} is offline`);
    return machine;
  }

  async function installedMachines() {
    return (await bb.sdk.hosts.list({ includeCreating: true })).filter(
      (machine) => machine.lifecycle.phase !== "destroyed",
    );
  }

  async function sshMachines() {
    const machines: Array<{
      name: string;
      resource: MachineResource;
      id: string;
      creating: boolean;
    }> = [];
    for (const machine of await installedMachines()) {
      if (
        machine.machineProviderId !== PROVIDER_ID ||
        machine.lifecycle.phase === "removing"
      )
        continue;
      const resource = machineResourceSchema.safeParse(
        await bb.experimental_machines.getResource(machine.id),
      );
      if (resource.success)
        machines.push({
          id: machine.id,
          name: machine.name,
          creating: machine.lifecycle.phase === "creating",
          resource: resource.data,
        });
    }
    return machines;
  }

  async function findMachine(
    via: string,
    resolved: ResolvedTarget,
    ownLaunchKey?: string,
  ) {
    return (
      (await sshMachines()).find(
        (machine) =>
          machine.resource.launchKey !== ownLaunchKey &&
          machine.resource.via === via &&
          sameResolvedTarget(machine.resource.resolved, resolved),
      ) ?? null
    );
  }

  async function routes(): Promise<RouteOption[]> {
    const config = await bb.sdk.system.config();
    return config.serverAccess.providers
      .filter((provider) => provider.availability.status === "available")
      .sort(
        (left, right) =>
          Number(left.routeKind === "local-network") -
          Number(right.routeKind === "local-network"),
      )
      .map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        urls: provider.urls.slice(0, MAX_ROUTE_URLS),
      }));
  }

  function resolve(via: string, target: SshTarget, signal: AbortSignal) {
    return host.call(
      "resolve",
      { target },
      { hostId: via, signal, timeoutMs: RESOLVE_TIMEOUT_MS },
    );
  }

  function executor(
    via: string,
    target: SshTarget,
    options: { linger: boolean },
  ): MachineExecutor {
    return {
      async exec(request) {
        const executionId = randomUUID();
        outputs.set(executionId, { hostId: via, write: request.onOutput });
        try {
          return await host.call(
            "exec",
            {
              executionId,
              target,
              command: request.command,
              stdin: request.stdin,
              timeoutMs: request.timeoutMs,
              linger: options.linger,
            },
            {
              hostId: via,
              signal: request.signal,
              timeoutMs: Math.min(
                request.timeoutMs + CALL_MARGIN_MS,
                MAX_CALL_TIMEOUT_MS,
              ),
            },
          );
        } finally {
          outputs.delete(executionId);
        }
      },
    };
  }

  async function check(args: {
    via: string;
    target: SshTarget;
    access: string | undefined;
    keepRunning: boolean;
    signal: AbortSignal;
  }): Promise<CheckReport> {
    await requireVia(args.via);
    const available = await routes();
    const route =
      args.access === undefined
        ? (available[0] ?? null)
        : (available.find((candidate) => candidate.id === args.access) ?? null);
    const inspection = await host.call(
      "inspect",
      { target: args.target, routeUrls: route?.urls ?? [] },
      { hostId: args.via, signal: args.signal, timeoutMs: INSPECT_TIMEOUT_MS },
    );
    const destination = args.target.destination;
    const blockers: string[] = [];
    if (route === null)
      blockers.push(
        args.access === undefined
          ? "No server route is set up. Set one up in Settings > Machines."
          : `The server route ${args.access} is not available.`,
      );
    let notes: string[] = [];
    if (inspection.facts !== null) {
      const machines = (await installedMachines()).map((machine) => ({
        hostId: machine.id,
        name: machine.name,
      }));
      blockers.push(
        ...probeBlockers({
          destination,
          facts: inspection.facts,
          route,
          machines,
        }),
      );
      notes = probeNotes({
        destination,
        facts: inspection.facts,
        keepRunning: args.keepRunning,
      });
    }
    return {
      inspection,
      blockers,
      notes,
      machineName:
        (await findMachine(args.via, inspection.resolved))?.name ?? null,
    };
  }

  return {
    host,
    machineName,
    requireVia,
    findMachine,
    sshMachines,
    resolve,
    executor,
    check,

    async connectionOptions(): Promise<ConnectionOptions> {
      const config = await bb.sdk.system.config();
      const machines = await bb.sdk.hosts.list({ type: "persistent" });
      return {
        machines: machines.map((machine) => ({
          id: machine.id,
          name: machine.name,
          connected: machine.status === "connected",
          server: machine.id === config.primaryHostId,
        })),
        routes: (await routes()).map(({ id, displayName }) => ({
          id,
          displayName,
        })),
      };
    },

    async configHosts(via: string, signal: AbortSignal) {
      await requireVia(via);
      const listed = await host.call(
        "listConfigHosts",
        {},
        { hostId: via, signal, timeoutMs: LIST_TIMEOUT_MS },
      );
      const machines = (await sshMachines()).filter(
        (machine) => machine.resource.via === via,
      );
      return {
        configPath: listed.configPath,
        truncated: listed.truncated,
        hosts: listed.hosts.map((entry): ListedConfigHost => ({
          ...entry,
          machineName:
            machines.find(
              (machine) => machine.resource.target.destination === entry.alias,
            )?.name ?? null,
        })),
      };
    },
  };
}

export type SshService = ReturnType<typeof createSshService>;
