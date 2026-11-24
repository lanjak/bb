import type { EventSource } from "../rpc-types.js";
import { githubAdapter } from "./github.js";
import type { EventAdapter } from "./types.js";
import { webhookAdapter } from "./webhook.js";

const adapters: Record<EventSource, EventAdapter> = {
  webhook: webhookAdapter,
  github: githubAdapter,
};

export function adapterFor(source: EventSource): EventAdapter {
  return adapters[source];
}

export type { EventAdapter } from "./types.js";
