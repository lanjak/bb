import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import type { CheckReport } from "../app-contract.js";
import { PROVIDER_ID } from "../provider-id.js";
import {
  formatResolved,
  machineInputsSchema,
  targetFromInputs,
  type MachineInputs,
} from "../target.js";
import { AGENT_TRUST_REFUSAL } from "./provider.js";
import type { SshService } from "./service.js";

const NEVER = new AbortController().signal;

const viaOption = {
  type: "string",
  placeholder: "machine",
  description:
    "Machine that runs ssh (id or name). Defaults to this thread's machine, then the server machine.",
} as const;

const targetOptions = {
  via: viaOption,
  port: {
    type: "integer",
    min: 1,
    max: 65535,
    description: "SSH port, when ssh_config does not set it",
  },
  "identity-file": {
    type: "string",
    placeholder: "path",
    description:
      "Private key file on the Connect from machine, absolute or ~/...",
  },
  access: {
    type: "string",
    placeholder: "route",
    description:
      "Server route this machine uses: connect, direct or another provider id",
  },
  json: { type: "boolean", description: "Print machine-readable JSON" },
} as const;

export function formatReport(destination: string, report: CheckReport): string {
  const { inspection } = report;
  const lines = [
    `${destination} resolves to ${formatResolved(inspection.resolved)}${inspection.resolved.proxyJump === null ? "" : ` through ${inspection.resolved.proxyJump}`}`,
  ];
  if (inspection.hostKey.fingerprint !== null)
    lines.push(
      `Host key (${inspection.hostKey.keyType}): ${inspection.hostKey.fingerprint} - ${inspection.hostKey.state}`,
    );
  const { facts } = inspection;
  if (facts !== null)
    lines.push(
      `${facts.os} ${facts.arch}, user ${facts.user}, Node ${facts.nodeVersion ?? "not found"}`,
    );
  if (inspection.message !== null) lines.push(inspection.message);
  if (report.machineName !== null)
    lines.push(`Already added as the machine ${report.machineName}`);
  for (const blocker of report.blockers) lines.push(`Problem: ${blocker}`);
  for (const note of report.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

export function registerSshCli(bb: BbPluginApi, service: SshService): void {
  async function resolveVia(
    value: string | undefined,
    context: PluginCliContext,
  ): Promise<string> {
    const machines = await bb.sdk.hosts.list();
    if (value !== undefined) {
      const matches = machines.filter(
        (machine) => machine.id === value || machine.name === value,
      );
      if (matches.length !== 1)
        throw new PluginCliError(
          matches.length === 0
            ? `No machine named ${value}`
            : `Several machines are named ${value}`,
          {
            code: "machine_not_found",
            hint: "Run `bb machine list` and pass the machine ID.",
          },
        );
      return matches[0]!.id;
    }
    if (context.threadId !== undefined) {
      const thread = await bb.sdk.threads.get({ threadId: context.threadId });
      if (thread.environmentId !== null) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        return environment.hostId;
      }
    }
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null)
      throw new PluginCliError("There is no server machine to connect from", {
        code: "machine_not_found",
        hint: "Pass --via <machine>.",
      });
    return primaryHostId;
  }

  async function hostName(hostId: string) {
    return service.machineName(hostId);
  }

  bb.cli.register(
    defineCli({
      name: "ssh",
      summary: "Add computers you reach over SSH as bb machines",
      commands: {
        hosts: cliCommand({
          summary: "List the Host aliases in ssh_config on a machine",
          options: {
            via: viaOption,
            json: targetOptions.json,
          },
          async run({ options }, context) {
            const via = await resolveVia(options.via, context);
            const listed = await service.configHosts(
              via,
              context.signal ?? NEVER,
            );
            if (options.json)
              return {
                exitCode: 0,
                stdout: JSON.stringify({ via, ...listed }),
              };
            const lines = listed.hosts.map((host) =>
              host.machineName === null
                ? host.alias
                : `${host.alias}  [${host.machineName}]`,
            );
            return {
              exitCode: 0,
              stdout:
                lines.length === 0
                  ? `No Host aliases in ${listed.configPath} on ${await hostName(via)}`
                  : [
                      ...lines,
                      ...(listed.truncated ? ["(more aliases omitted)"] : []),
                    ].join("\n"),
            };
          },
        }),
        probe: cliCommand({
          summary:
            "Check an SSH computer and show its host key fingerprint without trusting it",
          positionals: [
            {
              name: "destination",
              description: "Host alias, host name or user@host",
              required: true,
            },
          ],
          options: targetOptions,
          async run({ options, positionals }, context) {
            const via = await resolveVia(options.via, context);
            const inputs = parseInputs({
              via,
              destination: positionals.destination,
              port: options.port,
              identityFile: options["identity-file"],
              access: options.access,
            });
            const report = await service.check({
              via,
              target: targetFromInputs(inputs),
              access: inputs.access,
              keepRunning: true,
              signal: context.signal ?? NEVER,
            });
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify({ via, ...report })
                : formatReport(inputs.destination, report),
            };
          },
        }),
        add: cliCommand({
          summary: "Add an SSH computer as a machine",
          positionals: [
            {
              name: "destination",
              description: "Host alias, host name or user@host",
              required: true,
            },
          ],
          options: {
            ...targetOptions,
            name: { type: "string", description: "Machine name" },
            "host-key": {
              type: "string",
              placeholder: "SHA256:...",
              description:
                "Trust this host key fingerprint. Required for a new key. Refused for an agent thread that identifies itself (a guardrail, not a security boundary).",
            },
            "no-keep-running": {
              type: "boolean",
              description:
                "Do not enable lingering; the daemon stops when the user logs out",
            },
            "no-wait": {
              type: "boolean",
              description: "Return as soon as the machine is being created",
            },
          },
          async run({ options, positionals }, context) {
            if (
              context.threadId !== undefined &&
              options["host-key"] !== undefined
            )
              throw new PluginCliError(AGENT_TRUST_REFUSAL, {
                code: "host_key_needs_person",
              });
            const via = await resolveVia(options.via, context);
            const inputs = parseInputs({
              via,
              destination: positionals.destination,
              port: options.port,
              identityFile: options["identity-file"],
              access: options.access,
              name: options.name,
              hostKey: options["host-key"],
              keepRunning: !options["no-keep-running"],
            });
            const report = await service.check({
              via,
              target: targetFromInputs(inputs),
              access: inputs.access,
              keepRunning: inputs.keepRunning,
              signal: context.signal ?? NEVER,
            });
            const { hostKey } = report.inspection;
            if (hostKey.state === "unknown" && inputs.hostKey === undefined) {
              if (context.threadId !== undefined)
                throw new PluginCliError(
                  `${AGENT_TRUST_REFUSAL}\n${formatReport(inputs.destination, report)}`,
                  { code: "host_key_needs_person" },
                );
              throw new PluginCliError(
                formatReport(inputs.destination, report),
                {
                  code: "host_key_unconfirmed",
                  hint: `Check the fingerprint with the computer's owner, then run again with --host-key ${hostKey.fingerprint}`,
                },
              );
            }
            if (
              inputs.hostKey !== undefined &&
              inputs.hostKey !== hostKey.fingerprint
            )
              throw new PluginCliError(
                `--host-key does not match.\n${formatReport(inputs.destination, report)}`,
                { code: "host_key_mismatch" },
              );
            if (
              hostKey.state === "changed" ||
              hostKey.state === "unreachable" ||
              (hostKey.state === "trusted" &&
                (report.inspection.facts === null ||
                  report.blockers.length > 0))
            )
              throw new PluginCliError(
                formatReport(inputs.destination, report),
                {
                  code: "ssh_check_failed",
                },
              );
            const host = await bb.sdk.hosts.experimental_create({
              machineProviderId: PROVIDER_ID,
              inputs,
              wait: !options["no-wait"],
              ...(context.signal === undefined
                ? {}
                : { signal: context.signal }),
            });
            const added = host.lifecycle.phase === "active";
            if (!options["no-wait"] && !added)
              throw new PluginCliError(
                host.lifecycle.message ?? "The machine was not added",
                { code: "machine_create_failed" },
              );
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(host)
                : added
                  ? `Added ${host.name} (${host.id})`
                  : `Adding ${host.name} (${host.id}). Follow it with bb machine show ${host.id}`,
            };
          },
        }),
      },
    }),
  );
}

function parseInputs(raw: Record<string, unknown>): MachineInputs {
  const parsed = machineInputsSchema.safeParse(
    Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined),
    ),
  );
  if (!parsed.success)
    throw new PluginCliError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
      { code: "invalid_value" },
    );
  return parsed.data;
}
