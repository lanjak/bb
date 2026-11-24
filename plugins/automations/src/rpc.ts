import {
  automationEventDetailSchema,
  automationEventListResponseSchema,
  automationHookListResponseSchema,
  automationHookResponseSchema,
  automationHookSecretResponseSchema,
  automationDetailReadResultSchema,
  automationDetailResponseSchema,
  automationListResponseSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
  automationRunsInputSchema,
  automationsOverviewResponseSchema,
  createAutomationInputSchema,
  createHookInputSchema,
  deleteHookInputSchema,
  getEventInputSchema,
  getHookInputSchema,
  hookTestResponseSchema,
  listAutomationsInputSchema,
  listEventsInputSchema,
  listHooksInputSchema,
  rotateHookInputSchema,
  testHookInputSchema,
  projectAutomationInputSchema,
  runAutomationInputSchema,
  updateAutomationInputSchema,
} from "./rpc-types.js";
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { HookService } from "./hook-service.js";
import type { AutomationService } from "./service.js";

export const automationRpcContract = defineRpcContract({
  automations_overview: {
    input: z.null(),
    output: automationsOverviewResponseSchema,
  },
  automations_list: {
    input: listAutomationsInputSchema,
    output: automationListResponseSchema,
  },
  automations_get: {
    input: projectAutomationInputSchema,
    output: automationDetailReadResultSchema,
  },
  automations_create: {
    input: createAutomationInputSchema,
    output: automationDetailResponseSchema,
  },
  automations_update: {
    input: updateAutomationInputSchema,
    output: automationDetailResponseSchema,
  },
  automations_delete: {
    input: projectAutomationInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_pause: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_resume: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_run: {
    input: runAutomationInputSchema,
    output: automationRunRpcResponseSchema,
  },
  automations_runs: {
    input: automationRunsInputSchema,
    output: automationRunListResponseSchema,
  },
  automations_hooks_list: {
    input: listHooksInputSchema,
    output: automationHookListResponseSchema,
  },
  automations_hook_get: {
    input: getHookInputSchema,
    output: automationHookResponseSchema,
  },
  automations_hook_create: {
    input: createHookInputSchema,
    output: automationHookSecretResponseSchema,
  },
  automations_hook_rotate: {
    input: rotateHookInputSchema,
    output: automationHookSecretResponseSchema,
  },
  automations_hook_delete: {
    input: deleteHookInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_hook_test: {
    input: testHookInputSchema,
    output: hookTestResponseSchema,
  },
  automations_events: {
    input: listEventsInputSchema,
    output: automationEventListResponseSchema,
  },
  automations_event_get: {
    input: getEventInputSchema,
    output: automationEventDetailSchema,
  },
});

export function createRpcHandlers(
  service: AutomationService,
  hooks: HookService,
) {
  return {
    automations_overview() {
      return service.overview();
    },
    automations_list(input: z.output<typeof listAutomationsInputSchema>) {
      return service.list(input);
    },
    automations_get(input: z.output<typeof projectAutomationInputSchema>) {
      return service.get(input);
    },
    automations_create(input: z.output<typeof createAutomationInputSchema>) {
      return service.create(input);
    },
    automations_update(input: z.output<typeof updateAutomationInputSchema>) {
      return service.update(input);
    },
    automations_delete(input: z.output<typeof projectAutomationInputSchema>) {
      return service.delete(input);
    },
    automations_pause(input: z.output<typeof projectAutomationInputSchema>) {
      return service.pause(input);
    },
    automations_resume(input: z.output<typeof projectAutomationInputSchema>) {
      return service.resume(input);
    },
    automations_run(input: z.output<typeof runAutomationInputSchema>) {
      return service.run(input);
    },
    automations_runs(input: z.output<typeof automationRunsInputSchema>) {
      return service.runs(input);
    },
    automations_hooks_list(input: z.output<typeof listHooksInputSchema>) {
      return hooks.list(input);
    },
    automations_hook_get(input: z.output<typeof getHookInputSchema>) {
      return hooks.get(input);
    },
    automations_hook_create(input: z.output<typeof createHookInputSchema>) {
      return hooks.create(input);
    },
    automations_hook_rotate(input: z.output<typeof rotateHookInputSchema>) {
      return hooks.rotate(input);
    },
    automations_hook_delete(input: z.output<typeof deleteHookInputSchema>) {
      return hooks.delete(input);
    },
    automations_hook_test(input: z.output<typeof testHookInputSchema>) {
      return hooks.test(input);
    },
    automations_events(input: z.output<typeof listEventsInputSchema>) {
      return hooks.events(input);
    },
    automations_event_get(input: z.output<typeof getEventInputSchema>) {
      return hooks.event(input);
    },
  };
}
