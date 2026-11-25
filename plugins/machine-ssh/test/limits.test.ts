import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CONFIG_HOSTS,
  MAX_ROUTE_URLS,
  remoteFactsSchema,
  sshHostContract,
} from "../contract.js";
import { parseProbe } from "../host/probe.js";
import { createSshClient } from "../host/ssh-client.js";

describe.skipIf(process.platform === "win32")("host contract limits", () => {
  it("lists aliases without running the commands in the ssh config", async () => {
    const home = await mkdtemp(join(tmpdir(), "bb-ssh-limits-"));
    try {
      await mkdir(join(home, ".ssh"));
      const marker = join(home, "ran");
      await writeFile(
        join(home, ".ssh", "config"),
        `Match exec "touch '${marker}'"\n  Port 22\nHost box\n`,
      );
      const ssh = await createSshClient({
        dataDir: join(home, "data"),
        tempDir: join(home, "tmp"),
        signal: new AbortController().signal,
        env: { ...process.env, HOME: home },
      });
      expect((await ssh.listConfigHosts()).hosts).toEqual([{ alias: "box" }]);
      await expect(stat(marker)).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("cuts a large ssh config to what the contract accepts", async () => {
    const home = await mkdtemp(join(tmpdir(), "bb-ssh-limits-"));
    try {
      await mkdir(join(home, ".ssh"));
      await writeFile(
        join(home, ".ssh", "config"),
        Array.from(
          { length: MAX_CONFIG_HOSTS + 20 },
          (_, index) => `Host box-${index}`,
        ).join("\n"),
      );
      const ssh = await createSshClient({
        dataDir: join(home, "data"),
        tempDir: join(home, "tmp"),
        signal: new AbortController().signal,
        env: { ...process.env, HOME: home },
      });
      const result = await ssh.listConfigHosts();
      expect(result.truncated).toBe(true);
      expect(
        sshHostContract.listConfigHosts.output.parse(result).hosts,
      ).toHaveLength(MAX_CONFIG_HOSTS);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("cuts a probe with too many routes and installs", () => {
    const facts = remoteFactsSchema.parse(
      parseProbe(
        [
          "os=Linux",
          ...Array.from(
            { length: MAX_ROUTE_URLS + 4 },
            (_, index) => `route=200 http://route-${index}`,
          ),
          ...Array.from(
            { length: 70 },
            (_, index) => `install=host_${index} http://server`,
          ),
        ].join("\n"),
      ),
    );
    expect(facts.routes).toHaveLength(MAX_ROUTE_URLS);
    expect(facts.installs).toHaveLength(64);
  });
});
