import { describe, expect, it } from "vitest";
import { parseProbe } from "../host/probe.js";
import { classifySshFailure, sshFailureMessage } from "../host/messages.js";
import { probeBlockers } from "../server/checks.js";

const ESCAPE = String.fromCharCode(27);
const RETURN = String.fromCharCode(13);

const probe = (status: number) =>
  probeBlockers({
    destination: "box",
    facts: parseProbe(
      [
        "os=Linux",
        "node=/usr/bin/node",
        "nodeVersion=v22.19.0",
        "npm=/usr/bin/npm",
        "curl=/usr/bin/curl",
        `route=${String(status).padStart(3, "0")} http://server:38886`,
      ].join("\n"),
    ),
    route: {
      id: "direct",
      displayName: "Manual",
      urls: ["http://server:38886"],
    },
    machines: [],
  });

describe("route check", () => {
  it("accepts a server that answers 2xx", () => {
    expect(probe(200)).toEqual([]);
  });

  it.each([301, 403, 404, 502])("blocks on HTTP %i", (status) => {
    expect(probe(status)).toEqual([
      `box cannot use this bb server through Manual: http://server:38886 answered HTTP ${status}. Choose another server route or fix the network.`,
    ]);
  });

  it("blocks when nothing answers", () => {
    expect(probe(0)).toEqual([
      "box cannot use this bb server through Manual: http://server:38886 did not answer. Choose another server route or fix the network.",
    ]);
  });
});

describe("text from the remote computer", () => {
  it("drops control sequences from probe values", () => {
    const facts = parseProbe(
      [
        `os=Linux${RETURN}`,
        `user=${ESCAPE}]0;title${String.fromCharCode(7)}dev`,
        `arch=${ESCAPE}[31mx86_64${ESCAPE}[0m`,
      ].join("\n"),
    );
    expect(facts).toMatchObject({ os: "Linux", user: "dev", arch: "x86_64" });
  });

  it("drops control sequences from ssh errors and caps long lines", () => {
    const message = sshFailureMessage(
      `${ESCAPE}[2Jbanner${RETURN}\n${"x".repeat(900)}\n`,
      "failed",
    );
    expect(message.split("\n")).toEqual(["banner", "x".repeat(500)]);
    expect(
      classifySshFailure(
        `No ED25519 host key is known for box${ESCAPE}[31m and you have requested strict checking.`,
      ),
    ).toEqual({ kind: "unknown", name: "box" });
  });
});
