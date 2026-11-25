import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CONFIG_HOSTS, type Inspection } from "../contract.js";
import { portSchema, type ResolvedTarget, type SshTarget } from "../target.js";
import { sshEnvironment } from "./agent.js";
import { listConfigAliases, userSshConfigPath } from "./config-hosts.js";
import {
  changedKeyMessage,
  classifySshFailure,
  jumpHostMessage,
  sshFailureMessage,
} from "./messages.js";
import { PROBE_SCRIPT, parseProbe } from "./probe.js";
import { runProcess, type ProcessResult } from "./process.js";
import { remoteCommand } from "./remote.js";

const RESOLVE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 90_000;

const CONNECTION_OPTIONS = [
  "BatchMode yes",
  "ConnectTimeout 15",
  "ServerAliveInterval 15",
  "ServerAliveCountMax 4",
  "StrictHostKeyChecking yes",
  "UpdateHostKeys no",
  "CheckHostIP no",
  "ForwardAgent no",
  "ForwardX11 no",
  "ControlMaster no",
  "ControlPath none",
  "PermitLocalCommand no",
  "LogLevel ERROR",
];

interface ResolvedConfig {
  resolved: ResolvedTarget;
  knownHostsFiles: string[];
  globalKnownHostsFiles: string[];
}

export interface SshClientOptions {
  dataDir: string;
  tempDir: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

function quoted(path: string): string {
  return `"${path}"`;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function knownHostsName(
  hostname: string,
  port: number,
  alias: string | undefined,
): string {
  if (alias !== undefined) return alias;
  return port === 22 ? hostname : `[${hostname}]:${port}`;
}

export function parseSshConfigDump(output: string): ResolvedConfig {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0 && !values.has(line.slice(0, space)))
      values.set(line.slice(0, space), line.slice(space + 1).trim());
  }
  const hostname = values.get("hostname");
  const port = portSchema.safeParse(Number(values.get("port")));
  if (!hostname || !port.success)
    throw new Error("ssh -G did not report a host name and port");
  const optional = (key: string) => {
    const value = values.get(key);
    return value === undefined || value === "none" ? undefined : value;
  };
  const files = (key: string) =>
    (optional(key) ?? "").split(/\s+/u).filter((file) => file !== "");
  const strict = values.get("stricthostkeychecking");
  return {
    resolved: {
      user: values.get("user") ?? "",
      hostname,
      port: port.data,
      proxyJump: optional("proxyjump") ?? null,
      knownHostsName: knownHostsName(
        hostname,
        port.data,
        optional("hostkeyalias"),
      ),
      strictHostKeyChecking: strict === "true" || strict === "yes",
    },
    knownHostsFiles: files("userknownhostsfile"),
    globalKnownHostsFiles: files("globalknownhostsfile"),
  };
}

const knownHostsWrites = new Map<string, Promise<unknown>>();

async function updateKnownHosts(
  path: string,
  update: (lines: string[]) => string[] | null,
): Promise<boolean> {
  const run = async () => {
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return "";
      throw error;
    });
    const next = update(text.split("\n").filter((line) => line !== ""));
    if (next === null) return false;
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, next.map((line) => `${line}\n`).join(""), {
      mode: 0o600,
    });
    await rename(temporary, path);
    return true;
  };
  const previous = knownHostsWrites.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  knownHostsWrites.set(path, current);
  return current;
}

export async function createSshClient(options: SshClientOptions) {
  const baseEnv = options.env ?? process.env;
  await mkdir(options.dataDir, { recursive: true });
  await mkdir(options.tempDir, { recursive: true });
  const runDir = await mkdtemp(join(options.tempDir, "ssh-"));
  const bbKnownHosts = join(options.dataDir, "known_hosts");
  const configPath = userSshConfigPath(baseEnv);
  const includes = [
    `Include ${quoted(configPath)}`,
    "Host *",
    "Include /etc/ssh/ssh_config",
    "",
  ];
  const resolveConfig = join(runDir, "resolve.conf");
  const connectConfig = join(runDir, "connect.conf");
  await writeFile(resolveConfig, includes.join("\n"), { mode: 0o600 });
  await writeFile(
    connectConfig,
    ["Host *", ...CONNECTION_OPTIONS, ...includes].join("\n"),
    { mode: 0o600 },
  );
  const env = await sshEnvironment(baseEnv, options.signal);

  async function ssh(
    command: string,
    args: string[],
    run: {
      timeoutMs: number;
      stdin?: string;
      onOutput?: (chunk: string) => void;
    },
  ): Promise<ProcessResult> {
    try {
      return await runProcess(command, args, {
        env,
        signal: options.signal,
        ...run,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new Error(
          `${command} is not installed on this machine. Install OpenSSH and try again.`,
        );
      throw error;
    }
  }

  function targetArgs(target: SshTarget): string[] {
    return [
      ...(target.port === null ? [] : ["-p", String(target.port)]),
      ...(target.identityFile === null ? [] : ["-i", target.identityFile]),
    ];
  }

  async function resolveConfigFor(target: SshTarget): Promise<ResolvedConfig> {
    const result = await ssh(
      "ssh",
      [
        "-F",
        resolveConfig,
        ...targetArgs(target),
        "-G",
        "--",
        target.destination,
      ],
      { timeoutMs: RESOLVE_TIMEOUT_MS },
    );
    if (result.exitCode !== 0)
      throw new Error(
        sshFailureMessage(
          result.stderr,
          `ssh could not read the configuration for ${target.destination}`,
        ),
      );
    return parseSshConfigDump(result.stdout);
  }

  function connectArgs(
    target: SshTarget,
    knownHostsFiles: readonly string[],
  ): string[] {
    return [
      "-F",
      connectConfig,
      "-T",
      ...targetArgs(target),
      "-o",
      `UserKnownHostsFile=${knownHostsFiles.map(quoted).join(" ")}`,
      "-o",
      "RemoteCommand=none",
      "-o",
      "ClearAllForwardings=yes",
    ];
  }

  async function execute(
    target: SshTarget,
    config: ResolvedConfig,
    command: readonly string[],
    run: {
      timeoutMs: number;
      linger: boolean;
      stdin?: string;
      onOutput?: (chunk: string) => void;
    },
  ) {
    return ssh(
      "ssh",
      [
        ...connectArgs(target, [...config.knownHostsFiles, bbKnownHosts]),
        "--",
        target.destination,
        remoteCommand(command, { linger: run.linger }),
      ],
      run,
    );
  }

  async function capture(
    target: SshTarget,
    config: ResolvedConfig,
  ): Promise<
    { line: string; fingerprint: string; keyType: string } | { failure: string }
  > {
    const file = join(runDir, `capture-${randomUUID()}`);
    const result = await ssh(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "GlobalKnownHostsFile=none",
        "-o",
        "IgnoreUnknown=KnownHostsCommand",
        "-o",
        "KnownHostsCommand=none",
        "-o",
        "PreferredAuthentications=none",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-o",
        "HashKnownHosts=no",
        ...connectArgs(target, [file]),
        "--",
        target.destination,
        "true",
      ],
      { timeoutMs: CONNECT_TIMEOUT_MS },
    );
    const line = (await readFile(file, "utf8").catch(() => ""))
      .split("\n")
      .find((entry) => entry !== "" && !entry.startsWith("#"));
    if (line === undefined) {
      const failure = classifySshFailure(result.stderr);
      return {
        failure:
          failure.kind === "unknown"
            ? jumpHostMessage(failure.name, config.resolved.proxyJump)
            : sshFailureMessage(
                result.stderr,
                `ssh could not connect to ${target.destination}`,
              ),
      };
    }
    const listed = await ssh("ssh-keygen", ["-lf", file], {
      timeoutMs: RESOLVE_TIMEOUT_MS,
    });
    const match = /^\d+ (SHA256:\S+) .*\((\S+)\)$/mu.exec(listed.stdout.trim());
    if (listed.exitCode !== 0 || match === null)
      throw new Error("ssh-keygen could not read the host key");
    return { line, fingerprint: match[1]!, keyType: match[2]! };
  }

  function failureMessage(
    config: ResolvedConfig,
    result: ProcessResult,
  ): string {
    const failure = classifySshFailure(result.stderr);
    return failure.kind === "changed"
      ? changedKeyMessage({
          resolved: config.resolved,
          offendingFile: failure.offendingFile,
          bbKnownHosts,
        })
      : sshFailureMessage(result.stderr, `ssh exited with ${result.exitCode}`);
  }

  async function signIn(
    target: SshTarget,
    config: ResolvedConfig,
  ): Promise<
    | { state: "trusted" | "unknown"; message: string | null }
    | { state: "changed" | "unreachable"; message: string }
  > {
    const result = await execute(target, config, ["true"], {
      timeoutMs: CONNECT_TIMEOUT_MS,
      linger: true,
    });
    if (result.exitCode === 0) return { state: "trusted", message: null };
    const failure = classifySshFailure(result.stderr);
    const message = failureMessage(config, result);
    if (failure.kind === "changed") return { state: "changed", message };
    if (failure.kind === "unknown")
      return failure.name === config.resolved.knownHostsName
        ? { state: "unknown", message: null }
        : {
            state: "unreachable",
            message: jumpHostMessage(failure.name, config.resolved.proxyJump),
          };
    if (failure.kind === "auth") return { state: "trusted", message };
    return { state: "unreachable", message };
  }

  async function isKnown(config: ResolvedConfig): Promise<boolean> {
    const files = [
      ...config.knownHostsFiles,
      ...config.globalKnownHostsFiles,
      bbKnownHosts,
    ];
    for (const file of files) {
      const result = await ssh(
        "ssh-keygen",
        ["-F", config.resolved.knownHostsName, "-f", expandHome(file)],
        { timeoutMs: RESOLVE_TIMEOUT_MS },
      );
      if (result.exitCode === 0 && result.stdout.trim() !== "") return true;
    }
    return false;
  }

  return {
    async listConfigHosts() {
      const { aliases, truncated } = await listConfigAliases(
        configPath,
        MAX_CONFIG_HOSTS,
      );
      return {
        configPath,
        hosts: aliases.map((alias) => ({ alias })),
        truncated,
      };
    },

    async resolve(target: SshTarget) {
      const config = await resolveConfigFor(target);
      return { resolved: config.resolved, knownHost: await isKnown(config) };
    },

    async inspect(
      target: SshTarget,
      routeUrls: readonly string[],
    ): Promise<Inspection> {
      const config = await resolveConfigFor(target);
      const unreachable = (message: string): Inspection => ({
        resolved: config.resolved,
        hostKey: { state: "unreachable", fingerprint: null, keyType: null },
        message,
        facts: null,
      });
      const presented = await capture(target, config);
      if ("failure" in presented) return unreachable(presented.failure);
      const login = await signIn(target, config);
      if (login.state === "unreachable") return unreachable(login.message);
      const hostKey = {
        state: login.state,
        fingerprint: presented.fingerprint,
        keyType: presented.keyType,
      };
      if (login.state !== "trusted" || login.message !== null)
        return {
          resolved: config.resolved,
          hostKey,
          message: login.message,
          facts: null,
        };
      const probe = await execute(
        target,
        config,
        ["sh", "-c", PROBE_SCRIPT, "bb-probe", ...routeUrls],
        { timeoutMs: PROBE_TIMEOUT_MS, linger: true },
      );
      if (probe.exitCode !== 0)
        return {
          resolved: config.resolved,
          hostKey,
          message: sshFailureMessage(probe.stderr, "The bb probe failed"),
          facts: null,
        };
      return {
        resolved: config.resolved,
        hostKey,
        message: null,
        facts: parseProbe(probe.stdout),
      };
    },

    async trust(target: SshTarget, fingerprint: string) {
      const config = await resolveConfigFor(target);
      const login = await signIn(target, config);
      if (login.state === "changed" || login.state === "unreachable")
        throw new Error(login.message);
      const presented = await capture(target, config);
      if ("failure" in presented) throw new Error(presented.failure);
      if (presented.fingerprint !== fingerprint)
        throw new Error(
          `${config.resolved.knownHostsName} presented ${presented.fingerprint}, not the confirmed ${fingerprint}. Check the computer again before you trust it.`,
        );
      if (login.state === "trusted") return { pinnedKey: null };
      if (config.resolved.strictHostKeyChecking)
        throw new Error(
          `Your ssh config requires known hosts (StrictHostKeyChecking yes). Add the key of ${config.resolved.knownHostsName} yourself, then try again.`,
        );
      await updateKnownHosts(bbKnownHosts, (lines) =>
        lines.includes(presented.line) ? null : [...lines, presented.line],
      );
      return { pinnedKey: presented.line };
    },

    async forget(pinnedKey: string) {
      const removed = await updateKnownHosts(bbKnownHosts, (lines) =>
        lines.includes(pinnedKey)
          ? lines.filter((line) => line !== pinnedKey)
          : null,
      );
      return { removed };
    },

    async exec(
      target: SshTarget,
      command: readonly string[],
      run: {
        stdin: string;
        timeoutMs: number;
        linger: boolean;
        onOutput: (chunk: string) => void;
      },
    ) {
      const config = await resolveConfigFor(target);
      const result = await execute(target, config, command, run);
      if (result.exitCode === 255)
        run.onOutput(`\n${failureMessage(config, result)}\n`);
      return { exitCode: result.exitCode };
    },

    async dispose() {
      await rm(runDir, { recursive: true, force: true });
    },
  };
}

export type SshClient = Awaited<ReturnType<typeof createSshClient>>;
