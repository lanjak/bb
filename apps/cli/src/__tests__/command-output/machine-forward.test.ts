import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerMachineCommands } from "../../commands/machine.js";
import {
  parseBindAddress,
  parseForwardPorts,
} from "../../commands/machine-forward.js";

describe("bb machine forward arguments", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerMachineCommands(program, () => "http://server");

  it("listens on the same local port unless another one, or 0, is given", () => {
    expect(parseForwardPorts("5432")).toEqual({
      port: 5432,
      localPort: 5432,
    });
    expect(parseForwardPorts("5173:54321")).toEqual({
      port: 5173,
      localPort: 54321,
    });
    expect(parseForwardPorts("5173:0")).toEqual({ port: 5173, localPort: 0 });
  });

  it("rejects a port that is not an integer from 1 to 65535, and a host name", () => {
    for (const spec of [
      "0",
      "65536",
      "abc",
      "80:",
      ":80",
      "0:80",
      "80:65536",
      "1:2:3",
      "db.internal:5432",
      "10.0.0.5:80",
      "80.5",
    ])
      expect(() => parseForwardPorts(spec), spec).toThrow();
  });

  it("listens on loopback only", () => {
    expect(parseBindAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(parseBindAddress("localhost")).toBe("127.0.0.1");
    expect(parseBindAddress("::1")).toBe("::1");
    for (const address of ["0.0.0.0", "::", "192.168.1.5", "example.com"])
      expect(() => parseBindAddress(address), address).toThrow(/loopback/);
  });

  it("needs exactly one of --machine, --host and --thread", async () => {
    stubServerApi({ "v1.hosts.$get": vi.fn(async () => []) });
    await expect(
      runCommand(["machine", "forward", "5432"], register),
    ).rejects.toThrow();
    await expect(
      runCommand(
        ["machine", "forward", "5432", "--machine", "a", "--thread", "thr_x"],
        register,
      ),
    ).rejects.toThrow();
  });

  const held: net.Server[] = [];
  afterEach(async () => {
    for (const server of held.splice(0))
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function stubForward(access: { allowed: boolean; reason: string | null }) {
    const host = { id: "host_a", name: "box", status: "connected" };
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [host]),
      "v1.hosts.:id.$get": vi.fn(async () => host),
      "v1.system.port-relay-access.$get": vi.fn(async () => access),
    });
  }

  async function forwardFailure(spec: string): Promise<string> {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runCommand(["machine", "forward", spec, "--machine", "box"], register),
    ).rejects.toThrow("process.exit:1");
    return errors.mock.calls.map((call) => call.join(" ")).join("\n");
  }

  it("stops before it listens when the connection is a machine credential", async () => {
    stubForward({ allowed: false, reason: "machine_credential" });
    const output = await forwardFailure("5432:0");
    expect(output).toContain("machine credential");
    expect(output).toContain("desktop app");
    expect(output).toContain("direct server URL");
  });

  it("fails when the local port, by default the same one, is busy", async () => {
    stubForward({ allowed: true, reason: null });
    const server = net.createServer();
    held.push(server);
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as net.AddressInfo).port),
      ),
    );
    const output = await forwardFailure(String(port));
    expect(output).toContain(`Local port ${port} is already in use`);
    expect(output).toContain(`${port}:0`);
  });
});
