import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSshClient } from "../host/ssh-client.js";
import type { SshTarget } from "../target.js";
import {
  createSshHarness,
  fingerprintOf,
  SSHD_PATH,
  type Sshd,
} from "./sshd-harness.js";

const target = (destination: string): SshTarget => ({
  destination,
  port: null,
  identityFile: null,
});

describe.skipIf(SSHD_PATH === null || process.platform === "win32")(
  "ssh client against a real sshd",
  () => {
    let harness: Awaited<ReturnType<typeof createSshHarness>>;
    let server: Sshd;
    let jump: Sshd;
    let behind: Sshd;
    let agentSocket: string;

    beforeAll(async () => {
      harness = await createSshHarness();
      server = await harness.startSshd("server");
      jump = await harness.startSshd("jump");
      behind = await harness.startSshd("behind");
      agentSocket = await harness.startAgent();
      await harness.writeClientConfig([
        { alias: "box", port: server.port, extra: ["CheckHostIP yes"] },
        {
          alias: "strict",
          port: jump.port,
          extra: ["StrictHostKeyChecking yes"],
        },
        { alias: "hop", port: jump.port },
        { alias: "inner", port: behind.port, extra: ["ProxyJump hop"] },
      ]);
    });

    afterAll(async () => {
      await harness.dispose();
    });

    async function client(signal = new AbortController().signal) {
      return createSshClient({
        dataDir: join(harness.root, "data"),
        tempDir: join(harness.root, "tmp"),
        signal,
        env: {
          ...process.env,
          HOME: harness.clientHome,
          SSH_AUTH_SOCK: agentSocket,
        },
      });
    }

    const bbKnownHosts = () =>
      readFile(join(harness.root, "data", "known_hosts"), "utf8").catch(
        () => "",
      );

    it("lists config aliases and resolves one when asked", async () => {
      const ssh = await client();
      const result = await ssh.listConfigHosts();
      expect(result.hosts).toEqual(
        ["box", "strict", "hop", "inner"].map((alias) => ({ alias })),
      );
      expect((await ssh.resolve(target("inner"))).resolved).toMatchObject({
        hostname: "127.0.0.1",
        port: behind.port,
        proxyJump: "hop",
        knownHostsName: "bb-test-inner",
      });
    });

    it("shows an unknown key without offering a key, and pins only the confirmed one", async () => {
      const ssh = await client();
      const expected = fingerprintOf(`${server.hostKeyPath}.pub`);
      const inspection = await ssh.inspect(target("box"), []);
      expect(inspection.hostKey).toEqual({
        state: "unknown",
        fingerprint: expected,
        keyType: "ED25519",
      });
      expect(inspection.facts).toBeNull();
      expect(server.log()).not.toContain("method publickey");

      await expect(
        ssh.trust(target("box"), `SHA256:${"A".repeat(43)}`),
      ).rejects.toThrow("not the confirmed");
      expect(await bbKnownHosts()).toBe("");
      expect(server.log()).not.toContain("method publickey");

      const { pinnedKey } = await ssh.trust(target("box"), expected);
      expect(pinnedKey).toMatch(/^bb-test-box ssh-ed25519 /u);
      expect(await bbKnownHosts()).toBe(`${pinnedKey}\n`);
      await expect(readFile(harness.userKnownHosts, "utf8")).rejects.toThrow();
    });

    it("signs in with the agent key, probes, and runs a command with quoted arguments and stdin", async () => {
      const ssh = await client();
      const inspection = await ssh.inspect(target("box"), [
        "http://127.0.0.1:9",
      ]);
      expect(inspection.hostKey.state).toBe("trusted");
      expect(inspection.facts).toMatchObject({
        os: process.platform === "darwin" ? "Darwin" : "Linux",
        curl: true,
        routes: [{ url: "http://127.0.0.1:9", status: 0 }],
      });
      expect(inspection.facts?.nodeVersion).toMatch(/^v\d+\./u);

      let output = "";
      const result = await ssh.exec(
        target("box"),
        ["sh", "-c", 'printf "%s|" "$@"; cat; exit 7', "x", "a b", "'c'", "$d"],
        {
          stdin: "from stdin",
          timeoutMs: 20_000,
          linger: true,
          onOutput: (chunk) => (output += chunk),
        },
      );
      expect(result).toEqual({ exitCode: 7 });
      expect(output).toBe("a b|'c'|$d|from stdin");
    });

    it("passes the linger opt-out to the remote command", async () => {
      let output = "";
      await (
        await client()
      ).exec(
        target("box"),
        ["sh", "-c", 'printf "%s" "$BB_INSTALL_NO_LINGER"'],
        {
          stdin: "",
          timeoutMs: 20_000,
          linger: false,
          onOutput: (chunk) => (output += chunk),
        },
      );
      expect(output).toBe("1");
    });

    it("stops the ssh process when the call is aborted", async () => {
      const controller = new AbortController();
      const ssh = await client(controller.signal);
      const started = Date.now();
      const running = ssh.exec(target("box"), ["sleep", "30"], {
        stdin: "",
        timeoutMs: 60_000,
        linger: true,
        onOutput: () => {},
      });
      setTimeout(() => controller.abort(new Error("cancelled")), 800);
      await expect(running).rejects.toThrow("cancelled");
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("turns CheckHostIP off when the ssh config turns it on", async () => {
      await client();
      const [run] = await readdir(join(harness.root, "tmp"));
      const effective = spawnSync(
        "ssh",
        ["-F", join(harness.root, "tmp", run!, "connect.conf"), "-G", "box"],
        { encoding: "utf8" },
      );
      expect(effective.stdout.split("\n")).toContain("checkhostip no");
    });

    it("refuses to pin when the ssh config requires known hosts", async () => {
      const ssh = await client();
      await expect(
        ssh.trust(target("strict"), fingerprintOf(`${jump.hostKeyPath}.pub`)),
      ).rejects.toThrow("requires known hosts");
      expect(await bbKnownHosts()).not.toContain("bb-test-strict");
    });

    it("asks to trust a jump host in a terminal, then pins the target behind it", async () => {
      const ssh = await client();
      const blocked = await ssh.inspect(target("inner"), []);
      expect(blocked.hostKey.state).toBe("unreachable");
      expect(blocked.message).toContain("bb-test-hop");
      expect(blocked.message).toContain("(ProxyJump hop)");
      expect(blocked.message).toContain("Connect to it once in a terminal");

      const hopKey = await readFile(`${jump.hostKeyPath}.pub`, "utf8");
      await writeFile(harness.userKnownHosts, `bb-test-hop ${hopKey}`);

      const fingerprint = fingerprintOf(`${behind.hostKeyPath}.pub`);
      expect((await ssh.inspect(target("inner"), [])).hostKey.fingerprint).toBe(
        fingerprint,
      );
      await ssh.trust(target("inner"), fingerprint);
      expect((await ssh.inspect(target("inner"), [])).hostKey.state).toBe(
        "trusted",
      );
      expect(await readFile(harness.userKnownHosts, "utf8")).toBe(
        `bb-test-hop ${hopKey}`,
      );
    });

    it("refuses a changed host key before it offers a key, and forgets pins", async () => {
      const ssh = await client();
      const pinned = (await bbKnownHosts())
        .split("\n")
        .find((line) => line.startsWith("bb-test-box "))!;
      await server.replaceHostKey();
      const inspection = await ssh.inspect(target("box"), []);
      expect(inspection.hostKey.state).toBe("changed");
      expect(inspection.message).toContain("has changed");
      expect(inspection.message).toContain(
        join(harness.root, "data", "known_hosts"),
      );
      await expect(
        ssh.trust(target("box"), inspection.hostKey.fingerprint!),
      ).rejects.toThrow("has changed");
      let output = "";
      await ssh.exec(target("box"), ["true"], {
        stdin: "",
        timeoutMs: 20_000,
        linger: true,
        onOutput: (chunk) => (output += chunk),
      });
      expect(output).toContain("The host key of bb-test-box has changed");
      expect(output).not.toContain("jump host");
      expect(server.log()).not.toContain("method publickey");

      expect(await ssh.forget(pinned)).toEqual({ removed: true });
      expect(await bbKnownHosts()).not.toContain("bb-test-box ");
      expect((await ssh.inspect(target("box"), [])).hostKey.state).toBe(
        "unknown",
      );
    });
  },
);
