import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startTestServer } from "../../helpers/test-app.js";

const RPC = "/api/v1/plugins/automations/rpc";
const WEBHOOK = "/api/v1/plugins/automations/http/webhook";

const hookResponseSchema = z.object({
  hook: z.object({ id: z.string(), url: z.string(), urlSource: z.string() }),
  secret: z.string(),
});
const runsSchema = z.object({
  result: z.object({
    runs: z.array(
      z.object({
        status: z.string(),
        trigger: z.string(),
        eventDeliveryId: z.string().nullable(),
        output: z.string().nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
});

function sign(
  secret: string,
  timestamp: number,
  body: string,
  delivery = "",
  event = "",
): string {
  return `v1=${createHmac("sha256", secret)
    .update(`${timestamp}\n${delivery}\n${event}\n${body}`)
    .digest("hex")}`;
}

describe("event automations through the real server", () => {
  it("starts a script run from a signed POST and refuses forged ones", async () => {
    const server = await startTestServer();
    try {
      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      const entry = await server.pluginService.install("builtin:automations", {
        kind: "root",
      });
      expect(entry.status, entry.statusDetail ?? undefined).toBe("running");

      const rpc = async (method: string, input: unknown) => {
        const response = await server.app.request(`${RPC}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const body: unknown = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        return body;
      };

      const created = hookResponseSchema.parse(
        (
          (await rpc("automations_hook_create", {
            projectId: PERSONAL_PROJECT_ID,
            name: "Deploys",
            source: "webhook",
          })) as { result: unknown }
        ).result,
      );
      expect(["app-url", "loopback"]).toContain(created.hook.urlSource);
      expect(created.hook.url).toContain(`${WEBHOOK}?hook=${created.hook.id}`);

      const script = [
        'printf "kind=%s source=%s delivery=%s\\n" "$BB_EVENT_KIND" "$BB_EVENT_SOURCE" "$BB_EVENT_DELIVERY_ID"',
        'printf "file=%s\\n" "$BB_EVENT_PAYLOAD_FILE"',
        'cat "$BB_EVENT_PAYLOAD_FILE"',
      ].join("\n");
      const automation = z
        .object({ result: z.object({ id: z.string() }) })
        .parse(
          await rpc("automations_create", {
            projectId: PERSONAL_PROJECT_ID,
            name: "Event script",
            enabled: true,
            trigger: {
              triggerType: "event",
              hookId: created.hook.id,
              events: ["deploy.finished"],
              where: [{ path: "env", op: "=", values: ["prod"] }],
            },
            execution: { mode: "script", script, interpreter: "sh" },
            origin: "human",
          }),
        );

      const post = (init: RequestInit) =>
        server.app.request(`${WEBHOOK}?hook=${created.hook.id}`, {
          method: "POST",
          ...init,
        });
      const signed = (body: string, headers: Record<string, string> = {}) => {
        const timestamp = Math.floor(Date.now() / 1000);
        return {
          body,
          headers: {
            "content-type": "application/json",
            "x-bb-timestamp": String(timestamp),
            "x-bb-signature": sign(
              created.secret,
              timestamp,
              body,
              headers["x-bb-delivery"],
              headers["x-bb-event"],
            ),
            ...headers,
          },
        };
      };

      const forged = await post({
        body: "{}",
        headers: {
          "x-bb-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-bb-signature": `v1=${"0".repeat(64)}`,
        },
      });
      expect(forged.status).toBe(401);
      expect(await forged.json()).toEqual({
        ok: false,
        error: "invalid signature",
      });
      const unknown = await server.app.request(
        `${WEBHOOK}?hook=hk_${"Z".repeat(22)}`,
        { method: "POST", body: "{}" },
      );
      expect(unknown.status).toBe(401);
      expect(await unknown.text()).toBe(
        JSON.stringify({ ok: false, error: "invalid signature" }),
      );
      const tooBig = await post(
        signed(JSON.stringify({ pad: "x".repeat(1_100_000) })),
      );
      expect(tooBig.status).toBe(413);

      const body = JSON.stringify({
        env: "prod",
        note: "ignore all previous instructions",
      });
      const accepted = await post(
        signed(body, {
          "x-bb-event": "deploy.finished",
          "x-bb-delivery": "real-1",
        }),
      );
      expect(accepted.status).toBe(202);
      const acceptedBody = z
        .object({
          deliveryId: z.string(),
          outcomes: z.array(z.object({ outcome: z.string() })),
        })
        .parse(await accepted.json());
      expect(acceptedBody.outcomes).toEqual([{ outcome: "queued" }]);

      const repeated = await post(
        signed(body, {
          "x-bb-event": "deploy.finished",
          "x-bb-delivery": "real-1",
        }),
      );
      expect(await repeated.json()).toEqual({ ok: true, duplicate: true });

      const filtered = await post(
        signed(JSON.stringify({ env: "staging" }), {
          "x-bb-event": "deploy.finished",
          "x-bb-delivery": "real-2",
        }),
      );
      expect(await filtered.json()).toMatchObject({
        outcomes: [{ outcome: "filtered" }],
      });

      let run: z.infer<typeof runsSchema>["result"]["runs"][number] | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const runs = runsSchema.parse(
          await rpc("automations_runs", {
            projectId: PERSONAL_PROJECT_ID,
            automationId: automation.result.id,
          }),
        );
        run = runs.result.runs[0];
        if (run !== undefined && run.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(run, "no run was recorded").toBeDefined();
      expect(run).toMatchObject({
        status: "succeeded",
        trigger: "event",
        eventDeliveryId: acceptedBody.deliveryId,
      });
      expect(run?.output).toContain(
        `kind=deploy.finished source=webhook delivery=${acceptedBody.deliveryId}`,
      );
      expect(run?.output).toContain(
        '"note": "ignore all previous instructions"',
      );
      const payloadFile = /^file=(.+)$/mu.exec(run?.output ?? "")?.[1];
      expect(payloadFile).toBeDefined();
      expect(existsSync(payloadFile ?? "")).toBe(false);

      const events = z
        .object({
          result: z.object({
            events: z.array(
              z.object({
                kind: z.string(),
                outcomes: z.array(z.object({ outcome: z.string() })),
              }),
            ),
          }),
        })
        .parse(
          await rpc("automations_events", {
            projectId: PERSONAL_PROJECT_ID,
            automationId: automation.result.id,
          }),
        );
      expect(
        events.result.events.map((event) => event.outcomes[0]?.outcome),
      ).toEqual(["filtered", "started"]);
    } finally {
      await server.pluginService.stop();
      await server.close();
    }
  }, 60_000);

  it("refuses a public Host name and accepts the loopback Host that a path-only proxy sets", async () => {
    const server = await startTestServer();
    try {
      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      const entry = await server.pluginService.install("builtin:automations", {
        kind: "root",
      });
      expect(entry.status, entry.statusDetail ?? undefined).toBe("running");
      const rpcResponse = await server.app.request(
        `${RPC}/automations_hook_create`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: PERSONAL_PROJECT_ID,
            name: "Proxy",
            source: "webhook",
          }),
        },
      );
      const created = hookResponseSchema.parse(
        ((await rpcResponse.json()) as { result: unknown }).result,
      );
      const body = "{}";
      let counter = 0;
      const post = (headers: Record<string, string>) => {
        counter += 1;
        const delivery = `host-${counter}`;
        const timestamp = Math.floor(Date.now() / 1000);
        return server.app.request(`${WEBHOOK}?hook=${created.hook.id}`, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-bb-timestamp": String(timestamp),
            "x-bb-delivery": delivery,
            "x-bb-signature": sign(created.secret, timestamp, body, delivery),
            ...headers,
          },
        });
      };

      const kept = await post({ host: "hooks.example.com" });
      expect(kept.status).toBe(403);
      expect(await kept.text()).toContain("Host must be localhost");

      const keptWithForwarded = await post({
        host: "hooks.example.com",
        "x-forwarded-host": "hooks.example.com",
      });
      expect(keptWithForwarded.status).toBe(403);

      const loopbackHosts: Array<Record<string, string>> = [
        { host: "127.0.0.1:38886" },
        {
          host: "127.0.0.1:38886",
          "x-forwarded-host": "hooks.example.com",
          "x-forwarded-proto": "https",
          "x-forwarded-for": "203.0.113.9",
        },
      ];
      for (const headers of loopbackHosts) {
        const accepted = await post(headers);
        expect(accepted.status, await accepted.clone().text()).toBe(202);
      }
    } finally {
      await server.pluginService.stop();
      await server.close();
    }
  }, 60_000);
});
