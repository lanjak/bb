import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listRunningAutomationRuns, migrations } from "./data.js";
import { createEventQueue } from "./event-queue.js";
import { createHookService } from "./hook-service.js";
import { isValidWebhookBaseUrl } from "./hook-url.js";
import { ingestLegacyImport } from "./legacy-import.js";
import { pluginDataDirFromDb } from "./path.js";
import { automationRpcContract, createRpcHandlers } from "./rpc.js";
import {
  errorMessage,
  noteDispatchedMessage,
  reconcileQueuedMessages,
  reconcileRunningAutomationRuns,
  settleAutomationRunsForThread,
} from "./run.js";
import { registerAutomationCli } from "./cli.js";
import { createScriptRunScope } from "./script-runner.js";
import {
  assertNotRecursiveCreation,
  createAutomationService,
  requireProjectAvailable,
} from "./service.js";
import {
  hasConnectedHost,
  sleep,
  sweepDueAutomations,
  SWEEP_INTERVAL_MS,
} from "./sweep.js";
import { registerWebhookRoute } from "./webhook-route.js";

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const pluginDataDir = pluginDataDirFromDb(db);
  await ingestLegacyImport({ bb, db, pluginDataDir });
  const scriptRuns = createScriptRunScope();
  bb.onDispose(() => scriptRuns.stop());

  const service = createAutomationService({
    bb,
    db,
    pluginDataDir,
    scriptRuns,
  });

  const settings = bb.settings.define({
    webhookBaseUrl: {
      type: "string",
      label: "Webhook base URL",
      description:
        "Address that senders use to reach this server's webhook path, for example https://hooks.example.com. Use a reverse proxy or tunnel that forwards only /api/v1/plugins/automations/http/webhook to this server and answers 404 for every other path, with the upstream Host header set to this server's own address. Never forward the whole server: the rest of the API has no login. A Tailscale or LAN address works for senders on that network. Falls back to BB_APP_URL, then this machine's loopback address.",
      experimental_schema: z
        .string()
        .refine(isValidWebhookBaseUrl, "Enter an http(s) URL with no query"),
    },
  });
  const queue = createEventQueue({
    bb,
    db,
    pluginDataDir,
    scriptRuns,
    hasConnectedHost: () => hasConnectedHost(bb),
  });
  const drainQueue = () => {
    queue.drain().catch((error: unknown) => {
      bb.log.error(`Event queue drain failed: ${errorMessage(error)}`);
    });
  };
  const hooks = createHookService({
    bb,
    db,
    pluginDataDir,
    webhookBaseUrlSetting: async () => (await settings.get()).webhookBaseUrl,
    assertProjectAvailable: async (projectId) => {
      await requireProjectAvailable(bb, projectId);
    },
    assertNotRecursive: (threadId) =>
      assertNotRecursiveCreation(bb, db, threadId),
    onQueued: drainQueue,
  });

  bb.rpc.register(automationRpcContract, createRpcHandlers(service, hooks));
  registerAutomationCli({ bb, service, hooks });
  registerWebhookRoute({ bb, db, pluginDataDir, onQueued: drainQueue });

  bb.events.on("message.dispatched", ({ entry }) => {
    if (entry.originPluginId === bb.pluginId)
      noteDispatchedMessage(db, entry.id);
  });
  bb.events.on("experimental_thread.settled", (event) => {
    settleAutomationRunsForThread(bb, db, event);
    drainQueue();
  });

  bb.background.service("automation-sweep", {
    async start(signal) {
      let uncheckedRuns: ReadonlySet<string> = new Set(
        listRunningAutomationRuns(db).map((run) => run.id),
      );
      let serverHostId: string | null = null;
      while (!signal.aborted) {
        try {
          if (uncheckedRuns.size > 0) {
            uncheckedRuns = await reconcileRunningAutomationRuns(
              bb,
              db,
              uncheckedRuns,
            );
          }
          serverHostId ??= (await bb.sdk.system.config()).primaryHostId;
          await sweepDueAutomations(bb, db, {
            pluginDataDir,
            serverHostId,
            scriptRuns,
          });
          await reconcileQueuedMessages(bb, db);
          queue.maintain();
          await queue.drain();
        } catch (error) {
          bb.log.error(`Automation sweep failed: ${errorMessage(error)}`);
        }
        await sleep(SWEEP_INTERVAL_MS, signal);
      }
    },
  });
}
