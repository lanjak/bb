import { describe, expect, it } from "vitest";
import {
  HOST_DAEMON_COMPATIBLE_PROTOCOL_VERSIONS,
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonServerWsMessageSchema,
  hostPortConnectFailedMessageSchema,
  hostPortConnectMessageSchema,
  hostPortRelayDaemonPath,
} from "../src/index.js";

const relayId = "relay_0123456789abcdef";
const token = "T".repeat(43);

describe("host port relay protocol", () => {
  it("raises the protocol version above main's 284, and accepts only that version", () => {
    expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(285);
    expect(HOST_DAEMON_COMPATIBLE_PROTOCOL_VERSIONS).toEqual([285]);
  });

  it("accepts a connect message with a port in range and a long token", () => {
    const message = {
      type: "host-port.connect",
      relayId,
      port: 5432,
      token,
    };
    expect(hostPortConnectMessageSchema.parse(message)).toEqual(message);
    expect(hostDaemonServerWsMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects a port out of range, a host name in its place, a short token and extra fields", () => {
    for (const bad of [
      { port: 0 },
      { port: 65536 },
      { port: 80.5 },
      { port: "80" },
      { port: "example.com:80" },
      { token: "short" },
      { token: "a b".repeat(20) },
      { relayId: "../../etc/passwd" },
      { host: "10.0.0.5" },
      { address: "192.168.1.1" },
    ])
      expect(
        hostPortConnectMessageSchema.safeParse({
          type: "host-port.connect",
          relayId,
          port: 80,
          token,
          ...bad,
        }).success,
        JSON.stringify(bad),
      ).toBe(false);
  });

  it("accepts a connect failure with a known code and bounded message", () => {
    const message = {
      type: "host-port.connect-failed",
      relayId,
      code: "refused",
      message: "ECONNREFUSED",
    };
    expect(hostPortConnectFailedMessageSchema.parse(message)).toEqual(message);
    expect(hostDaemonDaemonWsMessageSchema.parse(message)).toEqual(message);
    expect(
      hostPortConnectFailedMessageSchema.safeParse({
        ...message,
        code: "anything",
      }).success,
    ).toBe(false);
    expect(
      hostPortConnectFailedMessageSchema.safeParse({
        ...message,
        message: "x".repeat(201),
      }).success,
    ).toBe(false);
  });

  it("builds the dial-back path from a relay id without letting it escape the prefix", () => {
    expect(hostPortRelayDaemonPath(relayId)).toBe(
      `/internal/host-ports/${relayId}`,
    );
    expect(hostPortRelayDaemonPath("a/../b")).toBe(
      "/internal/host-ports/a%2F..%2Fb",
    );
  });
});
