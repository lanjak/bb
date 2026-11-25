import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const SSHD_PATH =
  ["/usr/sbin/sshd", "/usr/bin/sshd"].find((path) => existsSync(path)) ?? null;

function keygen(path: string): void {
  const result = spawnSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

export function fingerprintOf(publicKeyPath: string): string {
  const result = spawnSync("ssh-keygen", ["-lf", publicKeyPath], {
    encoding: "utf8",
  });
  return result.stdout.split(" ")[1] ?? "";
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        return reject(new Error("No port"));
      server.close(() => resolve(address.port));
    });
  });
}

export interface Sshd {
  port: number;
  hostKeyPath: string;
  log(): string;
  replaceHostKey(): Promise<void>;
}

export async function createSshHarness() {
  const root = await mkdtemp(join(tmpdir(), "bb-ssh-test-"));
  const clientHome = join(root, "client-home");
  const remoteHome = join(root, "remote-home");
  await mkdir(join(clientHome, ".ssh"), { recursive: true });
  await mkdir(remoteHome, { recursive: true });
  const clientKey = join(root, "client_key");
  keygen(clientKey);
  const authorized = join(root, "authorized_keys");
  await writeFile(authorized, await readFile(`${clientKey}.pub`, "utf8"));
  const userKnownHosts = join(root, "user_known_hosts");
  const children: ChildProcess[] = [];

  async function startSshd(name: string): Promise<Sshd> {
    if (SSHD_PATH === null) throw new Error("sshd is not installed");
    const port = await freePort();
    const hostKeyPath = join(root, `${name}_host_key`);
    keygen(hostKeyPath);
    const configPath = join(root, `${name}.conf`);
    await writeFile(
      configPath,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKeyPath}`,
        `PidFile ${join(root, `${name}.pid`)}`,
        `AuthorizedKeysFile ${authorized}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "StrictModes no",
        "LogLevel DEBUG1",
        `SetEnv HOME=${remoteHome}`,
        "",
      ].join("\n"),
    );
    let log = "";
    let child: ChildProcess;
    const launch = async () => {
      child = spawn(SSHD_PATH, ["-D", "-e", "-f", configPath]);
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.stderr!.on("data", (chunk: Buffer) => {
          log += chunk.toString();
          if (log.includes(`Server listening on 127.0.0.1 port ${port}`))
            resolve();
        });
        child.once("exit", () => reject(new Error(`sshd exited:\n${log}`)));
      });
    };
    await launch();
    return {
      port,
      hostKeyPath,
      log: () => log,
      async replaceHostKey() {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
        await rm(hostKeyPath);
        await rm(`${hostKeyPath}.pub`);
        keygen(hostKeyPath);
        log = "";
        await launch();
      },
    };
  }

  async function writeClientConfig(
    hosts: ReadonlyArray<{ alias: string; port: number; extra?: string[] }>,
  ): Promise<void> {
    await writeFile(
      join(clientHome, ".ssh", "config"),
      [
        ...hosts.flatMap((host) => [
          `Host ${host.alias}`,
          "  HostName 127.0.0.1",
          `  Port ${host.port}`,
          `  User ${userInfo().username}`,
          `  HostKeyAlias bb-test-${host.alias}`,
          ...(host.extra ?? []).map((line) => `  ${line}`),
        ]),
        "Host *",
        `  UserKnownHostsFile ${userKnownHosts}`,
        "  GlobalKnownHostsFile /dev/null",
        "",
      ].join("\n"),
    );
  }

  async function startAgent(): Promise<string> {
    const socket = join(root, "agent.sock");
    const agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
    children.push(agent);
    for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const added = spawnSync("ssh-add", [clientKey], {
      encoding: "utf8",
      env: { ...process.env, SSH_AUTH_SOCK: socket },
    });
    if (added.status !== 0) throw new Error(added.stderr);
    return socket;
  }

  return {
    root,
    clientHome,
    clientKey,
    userKnownHosts,
    startSshd,
    writeClientConfig,
    startAgent,
    async dispose() {
      for (const child of children) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    },
  };
}
