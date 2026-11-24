import { describe, expect, it } from "vitest";
import { createNodeBbSdk } from "../src/node.js";

describe("hosts.experimental_portRelayUrl", () => {
  it("builds a ws URL from the server URL, keeping a path prefix", () => {
    const sdk = createNodeBbSdk({ baseUrl: "http://127.0.0.1:3000" });
    expect(
      sdk.hosts.experimental_portRelayUrl({ hostId: "host_a", port: 5432 }),
    ).toBe("ws://127.0.0.1:3000/ws/host-ports/host_a/5432");
    const secure = createNodeBbSdk({ baseUrl: "https://bb.example.com/base/" });
    expect(
      secure.hosts.experimental_portRelayUrl({ hostId: "host a", port: 80 }),
    ).toBe("wss://bb.example.com/base/ws/host-ports/host%20a/80");
  });

  it("rejects a port that is not an integer from 1 to 65535", () => {
    const sdk = createNodeBbSdk({ baseUrl: "http://127.0.0.1:3000" });
    for (const port of [0, 65536, 1.5, Number.NaN, -3])
      expect(() =>
        sdk.hosts.experimental_portRelayUrl({ hostId: "h", port }),
      ).toThrow(/port/);
  });
});
