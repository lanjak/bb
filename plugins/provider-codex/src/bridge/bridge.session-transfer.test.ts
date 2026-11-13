import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const SESSION_ID = "01a1aeff-c171-70b0-9ea6-4031c45d476b";
const ROLLOUT_NAME = `rollout-2026-11-06T14-55-59-${SESSION_ID}.jsonl`;

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let codexHome: string;

beforeEach(async () => {
  harness = createBridgeJsonRpcTestHarness(handleLine);
  codexHome = await mkdtemp(join(tmpdir(), "bb-codex-bridge-transfer-"));
});

afterEach(async () => {
  harness.restore();
  vi.unstubAllEnvs();
  await rm(codexHome, { recursive: true, force: true });
});

it("advertises session transfer and answers session/files and session/destination from the session CODEX_HOME", async () => {
  const dayDirectory = join(codexHome, "sessions", "2026", "11", "06");
  await mkdir(dayDirectory, { recursive: true });
  await writeFile(
    join(dayDirectory, ROLLOUT_NAME),
    `${JSON.stringify({ type: "session_meta", payload: { id: SESSION_ID, source: "cli" } })}\n`,
  );

  harness.sendRequest(1, "initialize", {
    protocolVersion: 2,
    client: { name: "test", version: "0" },
  });
  expect((await harness.waitForResponse(1)).result).toMatchObject({
    capabilities: { sessionTransfer: true },
  });

  const params = {
    providerThreadId: SESSION_ID,
    cwd: "/tmp/new-checkout",
    options: { envVars: { CODEX_HOME: codexHome } },
  };
  harness.sendRequest(2, "session/files", params);
  expect((await harness.waitForResponse(2)).result).toEqual({
    files: [
      {
        path: join(dayDirectory, ROLLOUT_NAME),
        relativePath: `2026/11/06/${ROLLOUT_NAME}`,
      },
    ],
  });

  harness.sendRequest(3, "session/destination", params);
  expect((await harness.waitForResponse(3)).result).toEqual({
    directory: join(codexHome, "sessions"),
    root: codexHome,
  });

  harness.sendRequest(4, "session/files", {
    ...params,
    providerThreadId: "../escape",
  });
  expect((await harness.waitForResponse(4)).error?.message).toContain(
    "Invalid Codex session id",
  );
});
