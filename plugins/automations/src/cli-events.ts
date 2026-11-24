import { cliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  cliError,
  formatTimestamp,
  JSON_OPTION,
  jsonOutput,
  PROJECT_OPTION,
  requireOptionValue,
  requireProjectId,
  table,
} from "./cli-common.js";
import { parseWhereExpression } from "./event-match.js";
import type { HookService } from "./hook-service.js";
import {
  AUTOMATION_RUNS_LIMIT_DEFAULT,
  AUTOMATION_RUNS_LIMIT_MAX,
  EVENT_RUNS_PER_HOUR_MAX,
} from "./limits.js";
import {
  eventSourceSchema,
  hookVerificationSchema,
  type AutomationEventTrigger,
  type AutomationHookResponse,
  type AutomationHookSecretResponse,
  type EventSource,
  type EventWhere,
  type HookVerification,
} from "./rpc-types.js";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

export const EVENT_OPTIONS = {
  on: {
    type: "enum",
    values: eventSourceSchema.options,
    description:
      "Start on events from a signed webhook (webhook or github) instead of a schedule",
  },
  hook: {
    type: "string",
    placeholder: "hook-id",
    description:
      "Existing hook to listen on, from `bb automation hook list`; omitted, a new hook is created and its secret printed once",
  },
  event: {
    type: "string",
    repeatable: true,
    placeholder: "kind",
    description:
      "Only start for this event kind, such as pull_request.opened or issues.*; repeat for several. Omitted means every kind",
  },
  where: {
    type: "string",
    repeatable: true,
    placeholder: "path op [values]",
    description:
      "Payload filter, for example 'issue.state = open' or 'sender.login in alice,bob'. Ops: = != in contains exists !exists. Repeat to require all",
  },
  pick: {
    type: "string",
    repeatable: true,
    placeholder: "path",
    description:
      "Payload field to show the agent, such as pull_request.title; repeat up to 16. Omitted shows the whole payload up to the size cap",
  },
  repo: {
    type: "string",
    placeholder: "owner/name",
    description: "GitHub only: repository the event is about",
  },
  branch: {
    type: "string",
    placeholder: "name",
    description:
      "GitHub only: branch of a push, or the base branch of a pull request",
  },
  label: {
    type: "string",
    placeholder: "name",
    description: "GitHub only: the label named by a labeled or unlabeled event",
  },
  actor: {
    type: "string",
    repeatable: true,
    placeholder: "login",
    description:
      "GitHub only: only events caused by this login (allow-list); repeat for several",
  },
  "ignore-actor": {
    type: "string",
    repeatable: true,
    placeholder: "login",
    description:
      "GitHub only: skip events caused by this login, for example the bot account your agent uses; repeat for several",
  },
  "include-forks": {
    type: "boolean",
    description:
      "GitHub only: also start for pull requests from forks, which are skipped by default",
  },
  "max-runs-per-hour": {
    type: "integer",
    min: 1,
    max: EVENT_RUNS_PER_HOUR_MAX,
    description:
      "Most runs this automation may start in an hour (default 20); further events are recorded as rate_limited",
  },
  verification: {
    type: "enum",
    values: hookVerificationSchema.options,
    description:
      "Webhook only, with a new hook: hmac signs each request (default); token sends the secret in X-Bb-Webhook-Token",
  },
  "allow-full-access-for-events": {
    type: "boolean",
    description:
      "Allow --permission-mode full for this event automation. Outside data then steers an unattended agent with full access. GitHub also needs --actor, which covers the actor and the authors of the text in the payload",
  },
  "revoke-full-access-for-events": {
    type: "boolean",
    description:
      "Withdraw the full-access acknowledgement. Lowering the permission mode below full does the same",
  },
} as const;

export const EVENT_OPTION_NAMES = Object.keys(EVENT_OPTIONS).filter(
  (name) => name !== "on",
);

export const EVENT_FLAG_CONSTRAINTS = EVENT_OPTION_NAMES.map((option) => ({
  kind: "requires" as const,
  option,
  needs: ["on"] as const,
}));

export interface EventOptionValues {
  on: EventSource | undefined;
  hook: string | undefined;
  event: string[];
  where: string[];
  pick: string[];
  repo: string | undefined;
  branch: string | undefined;
  label: string | undefined;
  actor: string[];
  "ignore-actor": string[];
  "include-forks": boolean;
  "max-runs-per-hour": number | undefined;
  verification: HookVerification | undefined;
  "allow-full-access-for-events": boolean;
  "revoke-full-access-for-events": boolean;
}

const GITHUB_FILTER_FLAGS = [
  "repo",
  "branch",
  "label",
  "actor",
  "ignore-actor",
  "include-forks",
] as const;

function usesGithubFilters(options: EventOptionValues): boolean {
  return GITHUB_FILTER_FLAGS.some((flag) => {
    const value = options[flag];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

export function hasEventFilterFlags(options: EventOptionValues): boolean {
  return options.where.length > 0 || usesGithubFilters(options);
}

function compileWhere(
  options: EventOptionValues,
  source: EventSource,
): EventWhere[] {
  const where: EventWhere[] = options.where.map((expression) => {
    try {
      return parseWhereExpression(expression);
    } catch (error) {
      throw cliError(
        error instanceof Error ? error.message : String(error),
        "invalid_value",
      );
    }
  });
  if (source !== "github") {
    if (usesGithubFilters(options)) {
      throw cliError(
        "--repo, --branch, --label, --actor, --ignore-actor and --include-forks apply to GitHub hooks; use --where for a generic webhook.",
        "unexpected_argument",
      );
    }
    return where;
  }
  const add = (path: string, op: EventWhere["op"], values: string[]) => {
    where.push({ path: `_bb.${path}`, op, values });
  };
  if (options.repo !== undefined) {
    add("repo", "=", [requireOptionValue("repo", options.repo)]);
  }
  if (options.branch !== undefined) {
    add("branch", "=", [requireOptionValue("branch", options.branch)]);
  }
  if (options.label !== undefined) {
    add("label", "=", [requireOptionValue("label", options.label)]);
  }
  if (options.actor.length > 0) {
    add("actor", "in", options.actor);
    add("authors", "within", options.actor);
  }
  for (const login of options["ignore-actor"]) add("actor", "!=", [login]);
  if (!options["include-forks"]) add("fork", "!=", ["true"]);
  return where;
}

export interface BuiltEventTrigger {
  trigger: AutomationEventTrigger;
  createdHook?: AutomationHookSecretResponse;
}

export async function buildEventTrigger(args: {
  hooks: HookService;
  options: EventOptionValues;
  projectId: string;
  automationName: string;
  ctx: Pick<PluginCliContext, "threadId">;
  current?: AutomationEventTrigger;
}): Promise<BuiltEventTrigger> {
  const { hooks, options, projectId } = args;
  const hookId = options.hook ?? args.current?.hookId;
  let source: EventSource;
  let createdHook: AutomationHookSecretResponse | undefined;
  if (hookId !== undefined) {
    const hook = await hooks.get({ projectId, hookId });
    if (options.on !== undefined && options.on !== hook.source) {
      throw cliError(
        `Hook ${hook.id} is a ${hook.source} hook, not ${options.on}.`,
        "invalid_value",
      );
    }
    source = hook.source;
  } else {
    if (options.on === undefined) {
      throw cliError(
        "--on is required to create an event hook.",
        "missing_required",
      );
    }
    source = options.on;
    if (source !== "webhook" && options.verification === "token") {
      throw cliError(
        "--verification token applies to generic webhooks only.",
        "invalid_value",
      );
    }
  }
  const filterFlagsGiven = hasEventFilterFlags(options);
  const where =
    filterFlagsGiven || args.current === undefined
      ? compileWhere(options, source)
      : args.current.where;
  if (hookId === undefined) {
    createdHook = await hooks.create({
      projectId,
      name: args.automationName,
      source,
      verification: options.verification ?? "hmac",
      ...(args.ctx.threadId === undefined
        ? {}
        : { callerThreadId: args.ctx.threadId }),
    });
  }
  const resolvedHookId = hookId ?? createdHook?.hook.id;
  if (resolvedHookId === undefined) {
    throw cliError("No hook could be resolved.", "command_failed");
  }
  const trigger: AutomationEventTrigger = {
    triggerType: "event",
    hookId: resolvedHookId,
    events:
      options.event.length > 0 ? options.event : (args.current?.events ?? []),
    where,
    pick: options.pick.length > 0 ? options.pick : (args.current?.pick ?? []),
    maxRunsPerHour:
      options["max-runs-per-hour"] ?? args.current?.maxRunsPerHour ?? 20,
    maxPayloadBytes: args.current?.maxPayloadBytes ?? 16_384,
    acknowledgeUntrustedInput: options["revoke-full-access-for-events"]
      ? false
      : options["allow-full-access-for-events"] ||
        (args.current?.acknowledgeUntrustedInput ?? false),
  };
  return { trigger, ...(createdHook === undefined ? {} : { createdHook }) };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function signingExample(hook: AutomationHookResponse): string {
  const url = shellQuote(hook.url);
  if (hook.source === "github") {
    return [
      "Add this in the repository: Settings > Webhooks > Add webhook",
      `  Payload URL:  ${hook.url}`,
      "  Content type: application/json",
      "  Secret:       the secret printed when the hook was created or rotated",
      "  Events:       the events you want, for example Issues or Pull requests",
      "GitHub signs every delivery with that secret; bb checks X-Hub-Signature-256.",
    ].join("\n");
  }
  if (hook.verification === "token") {
    return [
      'BODY=\'{"hello":"world"}\'',
      `curl -X POST ${url} \\`,
      "  -H 'content-type: application/json' \\",
      '  -H "X-Bb-Webhook-Token: $HOOK_SECRET" \\',
      "  -H 'X-Bb-Event: deploy.finished' \\",
      '  --data "$BODY"',
    ].join("\n");
  }
  return [
    'BODY=\'{"hello":"world"}\'',
    "TS=$(date +%s)",
    'DELIVERY="deploy-$TS"',
    "EVENT=deploy.finished",
    'SIG=$(printf \'%s\\n%s\\n%s\\n%s\' "$TS" "$DELIVERY" "$EVENT" "$BODY" | openssl dgst -sha256 -hmac "$HOOK_SECRET" -hex | sed \'s/^.* //\')',
    `curl -X POST ${url} \\`,
    "  -H 'content-type: application/json' \\",
    '  -H "X-Bb-Timestamp: $TS" \\',
    '  -H "X-Bb-Signature: v1=$SIG" \\',
    '  -H "X-Bb-Delivery: $DELIVERY" \\',
    '  -H "X-Bb-Event: $EVENT" \\',
    '  --data "$BODY"',
  ].join("\n");
}

export function secretWithheldMessage(args: {
  hookId: string;
  projectId: string;
}): string {
  return `This command ran inside a thread, and a thread's transcript is stored and sent to a model provider, so the secret is not printed. Reveal it once outside a thread: run \`bb automation hook rotate ${args.hookId} --project ${args.projectId} --yes\` in your terminal, or choose Rotate secret on the automation's Trigger card.`;
}

export function printHook(
  hook: AutomationHookResponse,
  options: {
    secret?: string;
    secretWithheld?: string;
    example?: boolean;
  } = {},
): string {
  const lines = [
    "",
    `  Hook:         ${hook.id}`,
    `  Name:         ${hook.name}`,
    `  Source:       ${hook.source}${hook.source === "webhook" ? ` (${hook.verification})` : ""}`,
    `  URL:          ${hook.url}`,
    `  URL from:     ${hook.urlSource === "setting" ? "webhookBaseUrl setting" : hook.urlSource === "app-url" ? "BB_APP_URL" : "this machine's loopback address"}`,
    `  Secret:       version ${hook.secretVersion}${hook.rotatedAt === null ? "" : `, rotated ${formatTimestamp(hook.rotatedAt)}`}`,
    `  Rejected:     ${hook.rejectedCount} request(s)${hook.lastRejectedAt === null ? "" : `, last ${formatTimestamp(hook.lastRejectedAt)}`}`,
    `  Automations:  ${hook.automationIds.length === 0 ? "-" : hook.automationIds.join(", ")}`,
  ];
  lines.push("", `  Warning: ${hook.urlWarning}`);
  if (options.secret !== undefined) {
    lines.push("", `  Secret (shown once, store it now): ${options.secret}`);
  }
  if (options.secretWithheld !== undefined) {
    lines.push("", `  Secret withheld. ${options.secretWithheld}`);
  }
  if (options.example) {
    lines.push(
      "",
      ...signingExample(hook)
        .split("\n")
        .map((line) => `  ${line}`),
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function createEventCommands(args: { hooks: HookService }) {
  const { hooks } = args;
  const hookIdPositional = {
    name: "hookId",
    description: "Hook id from `bb automation hook list`",
    required: true,
  } as const;

  return {
    "hook list": cliCommand({
      summary: "List the event hooks of a project",
      options: { project: PROJECT_OPTION, json: JSON_OPTION },
      run: async (input, ctx) => {
        const result = await hooks.list({
          projectId: requireProjectId(input.options.project, ctx),
        });
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput(result)
            : result.length === 0
              ? "No hooks found\n"
              : table(
                  ["ID", "Name", "Source", "Automations", "Rejected"],
                  result.map((hook) => [
                    hook.id,
                    hook.name,
                    hook.source,
                    String(hook.automationIds.length),
                    String(hook.rejectedCount),
                  ]),
                ),
        };
      },
    }),
    "hook show": cliCommand({
      summary: "Show a hook's URL, status and a ready sender example",
      description:
        "The secret is never shown again after creation. Rotate it with `hook rotate` if it was lost.",
      positionals: [hookIdPositional],
      options: { project: PROJECT_OPTION, json: JSON_OPTION },
      run: async (input, ctx) => {
        const hook = await hooks.get({
          projectId: requireProjectId(input.options.project, ctx),
          hookId: input.positionals.hookId,
        });
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput(hook)
            : printHook(hook, { example: true }),
        };
      },
    }),
    "hook create": cliCommand({
      summary: "Create an event hook and print its secret once",
      options: {
        project: PROJECT_OPTION,
        name: {
          type: "string",
          placeholder: "name",
          required: true,
          description: "Display name, at most 200 characters",
        },
        source: {
          type: "enum",
          values: eventSourceSchema.options,
          required: true,
          description:
            "webhook for any signed sender, github for repository webhooks",
        },
        verification: EVENT_OPTIONS.verification,
        json: JSON_OPTION,
      },
      run: async (input, ctx) => {
        const projectId = requireProjectId(input.options.project, ctx);
        const created = await hooks.create({
          projectId,
          name: input.options.name,
          source: input.options.source,
          verification: input.options.verification ?? "hmac",
          ...(ctx.threadId ? { callerThreadId: ctx.threadId } : {}),
        });
        const withheld = ctx.threadId
          ? secretWithheldMessage({ hookId: created.hook.id, projectId })
          : undefined;
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput(
                withheld === undefined
                  ? created
                  : { hook: created.hook, secretWithheld: withheld },
              )
            : printHook(created.hook, {
                ...(withheld === undefined
                  ? { secret: created.secret }
                  : { secretWithheld: withheld }),
                example: true,
              }),
        };
      },
    }),
    "hook rotate": cliCommand({
      summary: "Replace a hook's secret; the old secret stops working at once",
      positionals: [hookIdPositional],
      options: {
        project: PROJECT_OPTION,
        yes: {
          type: "boolean",
          description:
            "Required. Confirms senders are updated with the new secret",
        },
        json: JSON_OPTION,
      },
      run: async (input, ctx) => {
        if (!input.options.yes) {
          throw cliError(
            "Rotating a secret breaks every sender that still uses the old one; pass --yes.",
            "missing_required",
          );
        }
        if (ctx.threadId) {
          throw cliError(
            "Rotating a secret prints the new one, and a thread's transcript is stored and sent to a model provider. Run `bb automation hook rotate` outside a thread, or choose Rotate secret on the Trigger card.",
            "command_failed",
          );
        }
        const rotated = await hooks.rotate({
          projectId: requireProjectId(input.options.project, ctx),
          hookId: input.positionals.hookId,
          ...(ctx.threadId ? { callerThreadId: ctx.threadId } : {}),
        });
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput(rotated)
            : printHook(rotated.hook, { secret: rotated.secret }),
        };
      },
    }),
    "hook test": cliCommand({
      summary: "Send a sample event through a hook, without a signature",
      description:
        "Runs the same filters as a real delivery. By default nothing is stored and the prompt each agent would receive is printed; --send stores a sample delivery and starts real runs.",
      positionals: [hookIdPositional],
      options: {
        project: PROJECT_OPTION,
        "payload-json": {
          type: "string",
          placeholder: "json",
          stdin: true,
          description: "Sample payload as JSON; default {}",
        },
        kind: {
          type: "string",
          placeholder: "kind",
          description:
            "Event kind to simulate, such as issues.labeled (default call for a webhook, test for GitHub)",
        },
        send: {
          type: "boolean",
          description: "Store the delivery and start real runs",
        },
        json: JSON_OPTION,
      },
      run: async (input, ctx) => {
        let payload: JsonValue = {};
        const raw = input.options["payload-json"];
        if (raw !== undefined) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(raw);
          } catch {
            throw cliError(
              "--payload-json must be valid JSON.",
              "invalid_value",
            );
          }
          payload = z.json().parse(decoded);
        }
        const result = await hooks.test({
          projectId: requireProjectId(input.options.project, ctx),
          hookId: input.positionals.hookId,
          payload,
          ...(input.options.kind === undefined
            ? {}
            : { kind: input.options.kind }),
          dryRun: !input.options.send,
          ...(ctx.threadId ? { callerThreadId: ctx.threadId } : {}),
        });
        if (input.options.json) {
          return { exitCode: 0, stdout: jsonOutput(result) };
        }
        const lines = [
          result.dryRun
            ? `Dry run of ${result.kind}: nothing was stored`
            : `Sample delivery ${result.deliveryId} stored as ${result.kind}`,
          ...result.outcomes.map(
            (outcome) =>
              `  ${outcome.automationId}: ${outcome.outcome}${outcome.reason === null ? "" : ` (${outcome.reason})`}`,
          ),
        ];
        for (const preview of result.promptPreviews) {
          lines.push("", `Prompt for ${preview.automationId}:`, preview.prompt);
        }
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      },
    }),
    "hook delete": cliCommand({
      summary: "Delete a hook that no automation uses",
      positionals: [hookIdPositional],
      options: {
        project: PROJECT_OPTION,
        yes: {
          type: "boolean",
          description:
            "Required. Confirms the hook and its deliveries are deleted",
        },
        json: JSON_OPTION,
      },
      run: async (input, ctx) => {
        if (!input.options.yes) {
          throw cliError(
            "Deletion requires --yes when run through the plugin CLI.",
            "missing_required",
          );
        }
        await hooks.delete({
          projectId: requireProjectId(input.options.project, ctx),
          hookId: input.positionals.hookId,
          ...(ctx.threadId ? { callerThreadId: ctx.threadId } : {}),
        });
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, id: input.positionals.hookId })
            : `Hook ${input.positionals.hookId} deleted\n`,
        };
      },
    }),
    events: cliCommand({
      summary: "List the recent deliveries an automation or hook received",
      positionals: [
        {
          name: "id",
          description: "Automation id, or a hook id starting with hk_",
          required: true,
        },
      ],
      options: {
        project: PROJECT_OPTION,
        limit: {
          type: "integer",
          min: 1,
          max: AUTOMATION_RUNS_LIMIT_MAX,
          default: AUTOMATION_RUNS_LIMIT_DEFAULT,
          description: "How many recent deliveries to read",
        },
        json: JSON_OPTION,
      },
      run: async (input, ctx) => {
        const id = input.positionals.id;
        const result = hooks.events({
          projectId: requireProjectId(input.options.project, ctx),
          limit: input.options.limit,
          ...(id.startsWith("hk_") ? { hookId: id } : { automationId: id }),
        });
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput(result)
            : result.events.length === 0
              ? "No deliveries found\n"
              : table(
                  ["ID", "Received", "Kind", "Outcome"],
                  result.events.map((event) => [
                    event.id,
                    formatTimestamp(event.receivedAt),
                    event.kind,
                    event.outcomes
                      .filter(
                        (outcome) =>
                          id.startsWith("hk_") || outcome.automationId === id,
                      )
                      .map((outcome) => outcome.outcome)
                      .join(", ") || "no automation",
                  ]),
                ),
        };
      },
    }),
    "event show": cliCommand({
      summary:
        "Show one delivery: payload, outcomes and the prompt each agent got",
      positionals: [
        {
          name: "deliveryId",
          description: "Delivery id from `bb automation events`",
          required: true,
        },
      ],
      options: { project: PROJECT_OPTION, json: JSON_OPTION },
      run: async (input, ctx) => {
        const event = hooks.event({
          projectId: requireProjectId(input.options.project, ctx),
          deliveryId: input.positionals.deliveryId,
        });
        if (input.options.json) {
          return { exitCode: 0, stdout: jsonOutput(event) };
        }
        const lines = [
          `Delivery ${event.id} (${event.source} ${event.kind}) received ${formatTimestamp(event.receivedAt)}${event.sample ? " [sample]" : ""}`,
          ...event.outcomes.map(
            (outcome) =>
              `  ${outcome.automationId}: ${outcome.outcome}${outcome.reason === null ? "" : ` (${outcome.reason})`}${outcome.runId === null ? "" : ` run ${outcome.runId}`}`,
          ),
          "",
          "Payload:",
          event.payload === null
            ? "(too large to keep)"
            : JSON.stringify(event.payload, null, 2),
        ];
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      },
    }),
  };
}
