import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderCreateContext } from "@get-bb/plugin-sdk/machine-provider";
import type { RemoteFacts } from "../contract.js";
import {
  formatResolved,
  machineInputsSchema,
  machineResourceSchema,
  targetFromInputs,
  type MachineResource,
  type ResolvedTarget,
} from "../target.js";
import { PROVIDER_ID } from "../provider-id.js";
import { errorMessage, type SshService } from "./service.js";

export const AGENT_TRUST_REFUSAL =
  "bb does not take a new SSH host key from an agent thread. Ask a person to add this computer in Settings > Machines, or with bb ssh add in their own terminal.";

const VALIDATE_RESOLVE_TIMEOUT_MS = 7_000;
const UNINSTALL_TIMEOUT_MS = 60_000;
const LINGER_TIMEOUT_MS = 30_000;

export function machineNameFor(destination: string, name?: string): string {
  const fallback = destination.slice(destination.lastIndexOf("@") + 1);
  return (name ?? fallback)
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, 64);
}

function needsLinger(facts: RemoteFacts): boolean {
  return (
    facts.os === "Linux" &&
    facts.systemd &&
    !(facts.root && !facts.container) &&
    facts.linger !== true
  );
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? text;
}

function takenMessage(
  resolved: ResolvedTarget,
  machine: { name: string; creating: boolean },
): string {
  return machine.creating
    ? `bb is already adding ${formatResolved(resolved)} as ${machine.name}. Wait for that setup to finish, or remove that machine.`
    : `${formatResolved(resolved)} is already the machine ${machine.name}. Use Reconnect on that machine instead.`;
}

export function registerSshProvider(
  bb: BbPluginApi,
  service: SshService,
): void {
  let claims: Promise<unknown> = Promise.resolve();

  function claimTarget(resource: MachineResource, save: () => Promise<void>) {
    const claim = claims.then(async () => {
      const taken = await service.findMachine(
        resource.via,
        resource.resolved,
        resource.launchKey,
      );
      if (taken === null) await save();
      return taken;
    });
    claims = claim.catch(() => {});
    return claim;
  }

  async function create({
    inputs,
    key,
    checkpoint,
    report,
    signal,
  }: PluginMachineProviderCreateContext<typeof machineInputsSchema>) {
    const target = targetFromInputs(inputs);
    const via = await service.requireVia(inputs.via);
    report.step(`Checking ${inputs.destination} from ${via.name}`);
    const { resolved } = await service.resolve(via.id, target, signal);
    let resource: MachineResource = {
      via: via.id,
      target,
      resolved,
      keepRunning: inputs.keepRunning,
      pinnedKey: null,
      enabledLinger: false,
      launchKey: key,
    };
    const taken = await claimTarget(resource, () => checkpoint(resource));
    if (taken !== null)
      return {
        status: "failed" as const,
        message: takenMessage(resolved, taken),
      };
    const check = () =>
      service.check({
        via: via.id,
        target,
        access: inputs.access,
        keepRunning: inputs.keepRunning,
        signal,
      });
    let result = await check();
    const { hostKey } = result.inspection;
    if (hostKey.state === "unreachable" || hostKey.state === "changed")
      return {
        status: "failed" as const,
        message: result.inspection.message ?? "bb could not connect over SSH",
      };
    if (inputs.hostKey !== undefined && inputs.hostKey !== hostKey.fingerprint)
      return {
        status: "failed" as const,
        message: `${inputs.destination} presented ${hostKey.fingerprint}, not the confirmed ${inputs.hostKey}. Check the computer before you trust it.`,
      };
    if (hostKey.state === "unknown") {
      if (inputs.hostKey === undefined)
        return {
          status: "failed" as const,
          message: `bb does not trust the host key of ${inputs.destination} yet (${hostKey.keyType} ${hostKey.fingerprint}). Confirm the fingerprint and add the machine again.`,
        };
      report.step("Trusting the confirmed host key");
      const { pinnedKey } = await service.host.call(
        "trust",
        { target, fingerprint: inputs.hostKey },
        { hostId: via.id, signal, timeoutMs: 120_000 },
      );
      resource = { ...resource, pinnedKey };
      await checkpoint(resource);
      result = await check();
    }
    if (result.inspection.facts === null)
      return {
        status: "failed" as const,
        message:
          result.inspection.message ??
          `bb could not sign in to ${inputs.destination}`,
      };
    if (result.blockers.length > 0)
      return { status: "failed" as const, message: result.blockers.join("\n") };
    for (const note of result.notes) report.log(`${note}\n`);
    const executor = service.executor(via.id, target, {
      linger: inputs.keepRunning,
    });
    const { facts } = result.inspection;
    if (inputs.keepRunning && needsLinger(facts)) {
      report.step(`Turning on lingering for ${facts.user}`);
      const { exitCode } = await executor.exec({
        command: ["loginctl", "--no-ask-password", "enable-linger"],
        stdin: "",
        timeoutMs: LINGER_TIMEOUT_MS,
        signal,
        onOutput: (chunk) => report.log(chunk),
      });
      if (exitCode !== 0)
        return {
          status: "failed" as const,
          message: `Could not turn on lingering for ${facts.user} on ${inputs.destination}, so bb would stop when you log out. Run "sudo loginctl enable-linger ${facts.user}" on that computer and add it again, or turn off "Keep running after logout" (--no-keep-running).`,
        };
      resource = { ...resource, enabledLinger: true };
      await checkpoint(resource);
    }
    report.step(`Installing bb on ${inputs.destination}`);
    await bb.experimental_machines.bootstrap({
      key,
      executor,
      report,
      signal,
      ...(inputs.access === undefined
        ? {}
        : { access: { providerId: inputs.access } }),
    });
    return {
      status: "created" as const,
      name: machineNameFor(inputs.destination, inputs.name),
      resource,
    };
  }

  async function forgetPinnedKey(hostId: string, resource: MachineResource) {
    if (resource.pinnedKey === null) return;
    const shared = (await service.sshMachines()).some(
      (machine) =>
        machine.id !== hostId &&
        machine.resource.via === resource.via &&
        machine.resource.resolved.knownHostsName ===
          resource.resolved.knownHostsName,
    );
    if (shared) return;
    await service.host.call(
      "forget",
      { pinnedKey: resource.pinnedKey },
      { hostId: resource.via },
    );
  }

  bb.experimental_machines.register({
    id: PROVIDER_ID,
    displayName: "SSH",
    description:
      "Install bb on a Linux or macOS computer that one of your machines reaches over SSH.",
    icon: "Terminal",
    inputs: machineInputsSchema,
    async availability() {
      const machines = await bb.sdk.hosts.list({ type: "persistent" });
      return machines.some((machine) => machine.status === "connected")
        ? { status: "available" }
        : {
            status: "unavailable",
            message: "Connect a machine that can run ssh first.",
          };
    },
    async validate({ inputs, requestedByThreadId }) {
      try {
        await service.requireVia(inputs.via);
      } catch (error) {
        return { action: "refuse", message: errorMessage(error) };
      }
      if (requestedByThreadId !== null && inputs.hostKey !== undefined)
        return { action: "refuse", message: AGENT_TRUST_REFUSAL };
      const resolution = await service
        .resolve(
          inputs.via,
          targetFromInputs(inputs),
          AbortSignal.timeout(VALIDATE_RESOLVE_TIMEOUT_MS),
        )
        .catch(() => null);
      if (resolution === null) return { action: "accept" };
      const existing = await service.findMachine(
        inputs.via,
        resolution.resolved,
      );
      if (existing !== null)
        return {
          action: "refuse",
          message: takenMessage(resolution.resolved, existing),
        };
      if (requestedByThreadId !== null && !resolution.knownHost)
        return { action: "refuse", message: AGENT_TRUST_REFUSAL };
      return { action: "accept" };
    },
    async create(context) {
      try {
        return await create(context);
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async reconcileCleanup() {
      return { status: "removed" };
    },
    async executor({ resource }) {
      const owned = machineResourceSchema.parse(resource);
      await service.requireVia(owned.via).catch(async (error: unknown) => {
        throw new Error(
          `${errorMessage(error)}, so bb cannot reach ${owned.target.destination} over SSH`,
        );
      });
      return service.executor(owned.via, owned.target, {
        linger: owned.keepRunning,
      });
    },
    async remove({ hostId, resource, report, signal }) {
      const parsed = machineResourceSchema.safeParse(resource);
      if (!parsed.success) return { status: "removed" };
      const owned = parsed.data;
      const destination = owned.target.destination;
      const leftovers: string[] = [];
      const causes: string[] = [];
      try {
        await service.requireVia(owned.via);
        report.step(`Uninstalling bb from ${destination}`);
        await bb.experimental_machines.uninstall({
          hostId,
          executor: service.executor(owned.via, owned.target, {
            linger: owned.keepRunning,
          }),
          report,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(UNINSTALL_TIMEOUT_MS),
          ]),
        });
      } catch (error) {
        signal.throwIfAborted();
        leftovers.push(
          `The bb daemon may still run on ${destination}. To remove it, download install.sh from your bb server and run there: sh install.sh --uninstall --host-id ${hostId}`,
        );
        causes.push(`Uninstall failed: ${lastLine(errorMessage(error))}`);
      }
      if (owned.enabledLinger)
        leftovers.push(
          `bb turned on lingering for ${owned.resolved.user} on ${destination}, and it stays on. To turn it off, run on that computer: sudo loginctl disable-linger ${owned.resolved.user}`,
        );
      await forgetPinnedKey(hostId, owned).catch((error: unknown) => {
        signal.throwIfAborted();
        leftovers.push(
          `bb could not remove the trusted host key of ${destination} from the Connect from machine.`,
        );
        causes.push(`Key removal failed: ${lastLine(errorMessage(error))}`);
      });
      if (leftovers.length === 0) return { status: "removed" };
      const warning = [...leftovers, ...causes].join("\n");
      report.log(`${warning}\n`);
      bb.log.warn(warning);
      return { status: "removed", warning };
    },
  });
}
