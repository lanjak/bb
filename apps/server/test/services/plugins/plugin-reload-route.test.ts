import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createServer, IncomingMessage, request as httpRequest } from "node:http";
import { join } from "node:path";
import { getInstalledPlugin } from "@bb/db";
import {
  GATE_ASSERTION_HEADER,
  generateGateKeyPair,
  signGateAssertion,
} from "@bb/tunnel-contract/next";
import { createGateKeyStore } from "../../../src/services/connect-next/gate-keys.js";
import {
  createTunnelIngressManager,
  readVerifiedTunnelIngress,
} from "../../../src/services/connect-next/tunnel-ingress.js";
import { requestPluginManagedGeneration } from "../../../src/services/plugins/plugin-service-internal.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const BASE = "http://127.0.0.1:3334";

const HEALTHY_SOURCE = `export default function plugin(bb: any) {
  bb.cli.register({ name: "keeper", summary: "keeper", run() { return { exitCode: 0, stdout: "ok" }; } });
}
`;
const BROKEN_SOURCE = `export default function plugin() { throw new Error("boom on load"); }
`;

describe("POST /plugins/reload outcome", () => {
  let harness: TestAppHarness;
  let rootDir: string;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-keeper");
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-keeper",
        version: "0.1.0",
        bb: {
          name: "Keeper",
          description: "Reload outcome fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(rootDir, "server.ts"), HEALTHY_SOURCE);
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function signedEnable(
    body: string,
    verify: (response: { status: number; body: unknown }) => Promise<void>,
    afterResponse?: (incoming: IncomingMessage, request: Request) => Promise<void>,
  ): Promise<void> {
    const pair = await generateGateKeyPair("managed-enable");
    const keyServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [pair.publicKey] }));
    });
    let manager: ReturnType<typeof createTunnelIngressManager> | null = null;
    const failures: unknown[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        keyServer.once("error", reject);
        keyServer.listen(0, "127.0.0.1", () => {
          keyServer.off("error", reject);
          resolve();
        });
      });
      const address = keyServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("gate key server did not bind");
      }
      const path = "/api/v1/plugins/keeper/enable";
      let ownerRequests = 0;
      manager = createTunnelIngressManager({
        app: {
          async fetch(request, env) {
            if (!(env.incoming instanceof IncomingMessage)) {
              throw new Error("managed enable requires HTTP/1 ingress");
            }
            const proof = readVerifiedTunnelIngress(env.incoming, request);
            expect(proof).toMatchObject({
              ownerPolicyDerived: true,
              claims: { kind: "session", sub: "signed_owner" },
            });
            ownerRequests += 1;
            const response = await harness.app.fetch(request, env);
            await afterResponse?.(env.incoming, request);
            return response;
          },
        },
        injectWebSocket: () => {},
        keys: createGateKeyStore({
          url: () => `http://127.0.0.1:${address.port}/keys`,
          now: Date.now,
          logger: { debug: () => {}, warn: () => {} },
        }),
        loopbackOrigin: () => BASE,
        logger: { debug: () => {}, warn: () => {} },
      });
      const audience = "server:managed-enable";
      const lease = await manager.open(audience);
      const assertion = await signGateAssertion(pair.signingKey, {
        audience,
        subject: "signed_owner",
        kind: "session",
        method: "POST",
        pathAndQuery: path,
        target: null,
        oauth: null,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      const url = new URL(lease.baseUrl);
      const result = await new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              hostname: url.hostname,
              port: url.port,
              path,
              method: "POST",
              headers: {
                host: "managed-enable.next.getbb.app",
                "content-type": "application/json",
                [GATE_ASSERTION_HEADER]: assertion,
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("error", reject);
              response.on("end", () => {
                try {
                  resolve({
                    status: response.statusCode ?? 0,
                    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          request.on("error", reject);
          request.end(body);
        },
      );
      expect(ownerRequests).toBe(1);
      await verify(result);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await manager?.closeAll();
      } catch (error) {
        failures.push(error);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          keyServer.closeAllConnections();
          if (!keyServer.listening) {
            resolve();
            return;
          }
          keyServer.close((error) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  it("refuses signed owner managed generation without enabling or importing a disabled plugin", async () => {
    await harness.pluginService.setEnabled("keeper", false);
    await writeFile(
      join(rootDir, "server.ts"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(rootDir, "managed-imported"))}, "imported");\n${HEALTHY_SOURCE}`,
    );
    expect(getInstalledPlugin(harness.db, "keeper")?.enabled).toBe(false);
    await signedEnable(
      JSON.stringify({
        operatorIntent: {
          action: "request-managed-generation",
          computeChildRssAdmissionBytes: 1048576,
          attemptKey: "test_attempt-1",
        },
      }),
      async (response) => {
        expect(getInstalledPlugin(harness.db, "keeper")?.enabled).toBe(false);
        expect(harness.pluginService.getApi("keeper")).toBeUndefined();
        expect(await readdir(rootDir)).not.toContain("managed-imported");
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ ok: false });
      },
    );
  });

  it.each(["{}", "{malformed"])(
    "preserves ordinary signed enable behavior for body %s",
    async (body) => {
      await harness.pluginService.setEnabled("keeper", false);
      await signedEnable(body, async (response) => {
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true });
        expect(getInstalledPlugin(harness.db, "keeper")?.enabled).toBe(true);
        expect(harness.pluginService.getApi("keeper")).toBeDefined();
      });
    },
  );

  it.each([
    null,
    {},
    { action: "unknown", computeChildRssAdmissionBytes: 1, attemptKey: "a" },
    { action: "request-managed-generation", computeChildRssAdmissionBytes: 0, attemptKey: "a" },
    { action: "request-managed-generation", computeChildRssAdmissionBytes: 1.5, attemptKey: "a" },
    { action: "request-managed-generation", computeChildRssAdmissionBytes: Number.MAX_SAFE_INTEGER + 1, attemptKey: "a" },
    { action: "request-managed-generation", computeChildRssAdmissionBytes: 1, attemptKey: "a\n" },
    { action: "request-managed-generation", computeChildRssAdmissionBytes: 1, attemptKey: "a".repeat(129) },
    { action: "request-managed-generation", computeChildRssAdmissionBytes: 1, attemptKey: "a", extra: true },
  ])("rejects malformed explicit managed intent without enabling: %j", async (operatorIntent) => {
    await harness.pluginService.setEnabled("keeper", false);
    const response = await harness.app.request(`${BASE}/api/v1/plugins/keeper/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorIntent }),
    });
    expect(response.status).toBe(400);
    expect(getInstalledPlugin(harness.db, "keeper")?.enabled).toBe(false);
    expect(harness.pluginService.getApi("keeper")).toBeUndefined();
  });

  it("rejects unverified managed intent without ordinary enable fallback", async () => {
    await harness.pluginService.setEnabled("keeper", false);
    const response = await harness.app.request(`${BASE}/api/v1/plugins/keeper/enable`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bb-gate-owner": "signed_owner" },
      body: JSON.stringify({ operatorIntent: {
        action: "request-managed-generation",
        computeChildRssAdmissionBytes: 1048576,
        attemptKey: "unverified",
      } }),
    });
    expect(response.status).toBe(403);
    expect(getInstalledPlugin(harness.db, "keeper")?.enabled).toBe(false);
    expect(harness.pluginService.getApi("keeper")).toBeUndefined();
  });

  it("refuses warm managed replacement and consumes bounded attempts on the original signed request", async () => {
    const originalApi = harness.pluginService.getApi("keeper");
    const intent = {
      action: "request-managed-generation" as const,
      computeChildRssAdmissionBytes: 1048576,
      attemptKey: "warm_attempt",
    };
    await signedEnable(JSON.stringify({ operatorIntent: intent }), async (response) => {
      expect(response.status).toBe(409);
      expect(getInstalledPlugin(harness.db, "keeper")?.enabled).toBe(true);
      expect(harness.pluginService.getApi("keeper")).toBe(originalApi);
    }, async (incoming, request) => {
      const args = { pluginId: "keeper", intent, incoming, request };
      await expect(requestPluginManagedGeneration(harness.pluginService, args)).resolves.toMatchObject({
        status: 409,
        error: "managed generation attempt already consumed or limit reached",
      });
      await expect(requestPluginManagedGeneration(harness.pluginService, {
        ...args, request: request.clone(),
      })).resolves.toMatchObject({ status: 403 });
      for (let index = 1; index < 128; index += 1) {
        await expect(requestPluginManagedGeneration(harness.pluginService, {
          ...args, intent: { ...intent, attemptKey: `warm_${index}` },
        })).resolves.toMatchObject({
          status: 409,
          error: "managed generation cannot replace a running plugin",
        });
      }
      await expect(requestPluginManagedGeneration(harness.pluginService, {
        ...args, intent: { ...intent, attemptKey: "over_capacity" },
      })).resolves.toMatchObject({
        status: 409,
        error: "managed generation attempt already consumed or limit reached",
      });
      expect(harness.pluginService.getApi("keeper")).toBe(originalApi);
    });
  });

  it("answers ok with the plugin list when the reload applied", async () => {
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/reload?id=keeper`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ ok: true });
    expect(body).toMatchObject({
      plugins: expect.arrayContaining([
        expect.objectContaining({ id: "keeper", status: "running" }),
      ]),
    });
  });

  it("answers ok:false with the load problem when the new sources did not load (#2029)", async () => {
    await writeFile(join(rootDir, "server.ts"), BROKEN_SOURCE);
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/reload?id=keeper`,
      { method: "POST" },
    );
    expect(response.status).toBe(422);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      ok: false,
      error:
        'plugin "keeper" reload failed: boom on load (the previous instance is still running)',
      plugins: expect.arrayContaining([
        expect.objectContaining({
          id: "keeper",
          status: "running",
          statusDetail: "reload failed: boom on load",
        }),
      ]),
    });
  });
});
