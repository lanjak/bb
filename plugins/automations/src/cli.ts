import { isAbsolute } from "node:path";
import {
  experimental_resolveHostPath as resolveHostPath,
  experimental_getHostPathBasename as getHostPathBasename,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  printHook,
  secretWithheldMessage,
  buildEventTrigger,
  createEventCommands,
  EVENT_FLAG_CONSTRAINTS,
  EVENT_OPTIONS,
  EVENT_OPTION_NAMES,
  hasEventFilterFlags,
  type BuiltEventTrigger,
  type EventOptionValues,
} from "./cli-events.js";
import type { HookService } from "./hook-service.js";
import type { AutomationService } from "./service.js";
import type {
  AgentEnvironment,
  AgentExecutionUpdate,
  AutomationDetailResponse,
  AutomationReadProblem,
  AutomationReadResult,
  AutomationResponse,
  AutomationRunResponse,
  AutomationScriptInterpreter,
  AutomationScriptWorkingDirectory,
  PermissionMode,
  ReasoningLevel,
  ResolvedCreateAutomationInput,
  ScriptExecutionUpdate,
  UpdateAutomationInput,
} from "./rpc-types.js";
import {
  providerRoutingForEnvironment,
  resolvePermissionMode,
} from "./provider-permissions.js";
import {
  AUTOMATION_RUNS_LIMIT_DEFAULT,
  AUTOMATION_RUNS_LIMIT_MAX,
  AUTOMATION_SCRIPT_MAX_LENGTH,
  AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS,
  AUTOMATION_SCRIPT_TIMEOUT_MAX_MS,
} from "./limits.js";
import {
  automationScriptInterpreterSchema,
  permissionModeSchema,
  reasoningLevelSchema,
} from "./rpc-types.js";
import { formatWhere } from "./event-match.js";
import { interpreterForPath } from "./script-files.js";
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

const DURATION_PATTERN =
  /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/iu;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const DESCRIPTION = `Automations run agent prompts or server-side scripts on a schedule.

Scripts run on the bb server host. New standard-project scripts use the
project source on that host when one exists; Personal and projects without a
server-host source run in the plugin's shared script storage directory.
Existing scripts without a saved policy also run there. Select
automation-storage, project, or an absolute server-host path with
--working-directory. An unavailable selected directory fails the run.`;

const AUTOMATION_ID_POSITIONAL = {
  name: "automationId",
  description: "Automation id from `bb automation list`",
  required: true,
} as const;

const SCHEDULE_OPTIONS = {
  cron: {
    type: "string",
    placeholder: "expression",
    description:
      "Five-field cron expression, at most 100 characters; requires --timezone",
  },
  timezone: {
    type: "string",
    placeholder: "iana-timezone",
    description:
      "IANA timezone for --cron, for example America/New_York; only used with --cron",
  },
  at: {
    type: "string",
    placeholder: "datetime",
    description:
      "One-shot run time in the future, preferably ISO 8601 (2026-01-31T09:00:00Z)",
  },
  in: {
    type: "string",
    placeholder: "duration",
    description: "One-shot delay from now: 30s, 5m, 2h, or 1d",
  },
} as const;

const AGENT_OPTIONS = {
  prompt: {
    type: "string",
    placeholder: "text",
    description: "Prompt the agent runs when the automation is due",
  },
  provider: {
    type: "string",
    placeholder: "id",
    description: "Provider id, for example claude-code or codex",
  },
  model: {
    type: "string",
    placeholder: "model",
    description: "Model id the provider accepts",
  },
  reasoning: {
    type: "string",
    placeholder: "level",
    description:
      "Reasoning level id the model lists, for example low, medium, or high; new automations default to medium",
  },
  "service-tier": {
    type: "string",
    placeholder: "tier",
    description:
      "Service tier id the provider lists for the model, such as default or fast",
  },
  "clear-service-tier": {
    type: "boolean",
    description: "Leave the automation without a service tier",
  },
  "permission-mode": {
    type: "enum",
    values: permissionModeSchema.options,
    description:
      "Permission mode; defaults to the provider's best of auto then full",
  },
  "target-thread": {
    type: "string",
    placeholder: "thread-id",
    description: "Re-prompt this existing thread instead of spawning one",
  },
  environment: {
    type: "string",
    placeholder: "id-or-path",
    description:
      "Existing environment id, or a workspace path on the calling thread's machine, else the primary host",
  },
  "new-environment": {
    type: "enum",
    values: ["worktree"],
    description: "Create a fresh environment of this kind for each run",
  },
  "base-branch": {
    type: "string",
    placeholder: "branch",
    description: "Base branch for --new-environment worktree",
  },
} as const;

const SCRIPT_OPTIONS = {
  script: {
    type: "string",
    placeholder: "inline",
    description: `Inline script body, at most ${AUTOMATION_SCRIPT_MAX_LENGTH} characters`,
  },
  "script-file": {
    type: "string",
    placeholder: "path",
    description:
      "Copy the script from this file; relative paths resolve against the invoking directory",
  },
  host: {
    type: "string",
    placeholder: "name-or-id",
    description:
      "Host holding --script-file; defaults to the thread's environment host, else the server host",
  },
  interpreter: {
    type: "enum",
    values: automationScriptInterpreterSchema.options,
    description:
      "Interpreter for the script; a new script infers it from the --script-file extension when omitted, and an update keeps the current one",
  },
  timeout: {
    type: "duration",
    defaultUnit: "ms",
    min: 1,
    max: AUTOMATION_SCRIPT_TIMEOUT_MAX_MS,
    description: `Run timeout; a bare number is milliseconds (default ${AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS}, max ${AUTOMATION_SCRIPT_TIMEOUT_MAX_MS})`,
  },
  "env-json": {
    type: "string",
    placeholder: "json",
    description:
      'Script environment variables as a JSON object of string values, for example {"CHANNEL":"qa"}',
  },
  "working-directory": {
    type: "string",
    placeholder: "automation-storage|project|path",
    description:
      "Where the script runs: automation-storage, project, or an absolute path on the bb server host",
  },
} as const;

interface ScheduleOptionValues {
  cron: string | undefined;
  timezone: string | undefined;
  at: string | undefined;
  in: string | undefined;
}

interface AgentOptionValues {
  prompt: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  reasoning: ReasoningLevel | undefined;
  "service-tier": string | undefined;
  "clear-service-tier": boolean | undefined;
  "permission-mode": PermissionMode | undefined;
  "target-thread": string | undefined;
  environment: string | undefined;
  "new-environment": "worktree" | undefined;
  "base-branch": string | undefined;
}

interface ScriptOptionValues {
  script: string | undefined;
  "script-file": string | undefined;
  host: string | undefined;
  interpreter: AutomationScriptInterpreter | undefined;
  timeout: number | undefined;
  "env-json": string | undefined;
  "working-directory": string | undefined;
}

type ExecutionOptionValues = AgentOptionValues & ScriptOptionValues;

type UpdateOptionValues = ExecutionOptionValues &
  ScheduleOptionValues &
  EventOptionValues & {
    project: string | undefined;
    name: string | undefined;
  };

function parseRunAt(value: string): number {
  if (DATE_ONLY_PATTERN.test(value.trim())) {
    throw cliError(
      "--at needs a time of day, such as 2026-08-25T09:00; a date alone is ambiguous about its time zone.",
      "invalid_value",
    );
  }
  const runAt = Date.parse(value);
  if (!Number.isFinite(runAt)) {
    throw cliError(
      "--at must be a valid date/time, preferably ISO 8601.",
      "invalid_value",
    );
  }
  if (runAt <= Date.now()) {
    throw cliError("--at must be in the future.", "invalid_value");
  }
  return runAt;
}

function parseRunIn(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw cliError(
      "--in must be a duration like 30s, 5m, 2h, or 1d.",
      "invalid_value",
    );
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (amount <= 0) {
    throw cliError("--in must be greater than zero.", "invalid_value");
  }
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit.startsWith("s")
    ? 1_000
    : unit.startsWith("m")
      ? 60_000
      : unit.startsWith("h")
        ? 60 * 60_000
        : 24 * 60 * 60_000;
  return Date.now() + amount * multiplier;
}

function buildTrigger(
  options: ScheduleOptionValues,
): ResolvedCreateAutomationInput["trigger"] {
  const { cron, at, in: runIn, timezone } = options;
  const triggerFlags = [cron, at, runIn].filter(
    (value) => value !== undefined,
  ).length;
  if (triggerFlags !== 1) {
    throw cliError(
      "Provide exactly one schedule flag: --cron, --at, or --in.",
      "missing_required",
    );
  }
  if (cron !== undefined) {
    if (!timezone)
      throw cliError("--cron requires --timezone.", "missing_required");
    return { triggerType: "schedule", cron, timezone };
  }
  if (timezone !== undefined) {
    throw cliError(
      "--timezone is only used with --cron.",
      "unexpected_argument",
    );
  }
  if (at !== undefined) return { triggerType: "once", runAt: parseRunAt(at) };
  if (runIn !== undefined) {
    return { triggerType: "once", runAt: parseRunIn(runIn) };
  }
  throw cliError(
    "Provide exactly one schedule flag: --cron, --at, or --in.",
    "missing_required",
  );
}

function parseScriptWorkingDirectory(
  raw: string,
): AutomationScriptWorkingDirectory {
  const value = requireOptionValue("working-directory", raw);
  if (value === "automation-storage" || value === "project") {
    return { type: value };
  }
  if (isAbsolute(value)) return { type: "path", path: value };
  throw cliError(
    "Invalid --working-directory. Expected automation-storage, project, or an absolute path on the bb server host.",
    "invalid_value",
  );
}

function validateAgentTargetOptions(options: AgentOptionValues): void {
  if (options["clear-service-tier"] && options["service-tier"] !== undefined) {
    throw cliError(
      "Cannot combine --service-tier and --clear-service-tier.",
      "unexpected_argument",
    );
  }
  const targetThread = options["target-thread"];
  const environment = options.environment;
  const newEnvironment = options["new-environment"];
  if (targetThread !== undefined) {
    requireOptionValue("target-thread", targetThread);
  }
  if (environment !== undefined) requireOptionValue("environment", environment);
  const provided = [targetThread, environment, newEnvironment].filter(
    (value) => value !== undefined,
  );
  if (provided.length > 1) {
    throw cliError(
      "Cannot combine target options: --target-thread, --environment, and --new-environment.",
      "unexpected_argument",
    );
  }
  if (
    options["base-branch"] !== undefined &&
    options["new-environment"] === undefined
  ) {
    throw cliError(
      "--base-branch requires --new-environment worktree.",
      "missing_required",
    );
  }
}

function parseScriptEnv(
  value: string | undefined,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw cliError(
      "--env-json must be a JSON object of string values.",
      "invalid_value",
    );
  }
  const parsed = z.record(z.string(), z.string()).safeParse(decoded);
  if (!parsed.success) {
    throw cliError(
      "--env-json must be a JSON object of string values.",
      "invalid_value",
    );
  }
  return parsed.data;
}

function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith(".") ||
    value.startsWith("~")
  );
}

async function resolveAgentHostId(
  bb: Pick<BbPluginApi, "sdk">,
  ctx: Pick<PluginCliContext, "threadId">,
): Promise<string> {
  const threadHostId =
    ctx.threadId === undefined
      ? null
      : await readThreadHostId(bb, ctx.threadId);
  if (threadHostId !== null) return threadHostId;
  const { primaryHostId } = await bb.sdk.system.config();
  if (primaryHostId === null) {
    throw cliError("No primary host is available.", "no_connected_host");
  }
  return primaryHostId;
}

async function buildAgentEnvironment(
  bb: Pick<BbPluginApi, "sdk">,
  options: AgentOptionValues,
  ctx: Pick<PluginCliContext, "threadId">,
): Promise<AgentEnvironment> {
  const environment = options.environment?.trim();
  const newEnvironment = options["new-environment"];
  const baseBranch = options["base-branch"]?.trim();
  if (environment && newEnvironment) {
    throw cliError(
      "Cannot combine --environment with --new-environment.",
      "unexpected_argument",
    );
  }
  if (newEnvironment) {
    return {
      type: "host",
      hostId: await resolveAgentHostId(bb, ctx),
      workspace: {
        type: "managed-worktree",
        baseBranch: baseBranch
          ? { kind: "named", name: baseBranch }
          : { kind: "default" },
      },
    };
  }
  if (!environment) return { type: "project-default" };
  if (looksLikePath(environment)) {
    return {
      type: "host",
      hostId: await resolveAgentHostId(bb, ctx),
      workspace: { type: "unmanaged", path: environment },
    };
  }
  return { type: "reuse", environmentId: environment };
}

const scriptFileHostListSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1) }).passthrough(),
);
const threadEnvironmentHostSchema = z
  .object({
    environment: z
      .object({ hostId: z.string().min(1) })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

async function readThreadHostId(
  bb: Pick<BbPluginApi, "sdk">,
  threadId: string,
): Promise<string | null> {
  const thread = threadEnvironmentHostSchema.parse(
    await bb.sdk.threads.get({ threadId, include: "environment" }),
  );
  return thread.environment?.hostId ?? null;
}

async function resolveScriptFileHostId(
  bb: Pick<BbPluginApi, "sdk">,
  ctx: Pick<PluginCliContext, "threadId">,
  override: string | undefined,
): Promise<string | undefined> {
  if (override !== undefined) {
    const query = override.trim();
    if (query.length === 0) {
      throw cliError("--host requires a name or id.", "invalid_value");
    }
    const hosts = scriptFileHostListSchema.parse(await bb.sdk.hosts.list());
    const idMatch = hosts.find((host) => host.id === query);
    if (idMatch) return idMatch.id;
    const nameMatches = hosts.filter(
      (host) => host.name.toLocaleLowerCase() === query.toLocaleLowerCase(),
    );
    if (nameMatches.length === 1) return nameMatches[0]!.id;
    if (nameMatches.length > 1) {
      throw cliError(
        `Host name "${query}" is ambiguous; pass one of these ids: ${nameMatches
          .map((host) => host.id)
          .join(", ")}`,
        "invalid_value",
      );
    }
    throw cliError(
      `Unknown host "${query}"; run \`bb machine list\` to list hosts.`,
      "invalid_value",
    );
  }
  if (ctx.threadId === undefined) return undefined;
  const hostId = await readThreadHostId(bb, ctx.threadId);
  if (hostId === null) {
    throw cliError(
      `Thread ${ctx.threadId} has no environment, so the --script-file host cannot be resolved; pass --host <name-or-id>.`,
      "invalid_value",
    );
  }
  return hostId;
}

type ScriptFileSource = {
  path: string;
  fileName: string;
  hostId: string | undefined;
  content: string;
};

async function loadScriptFileSource(
  bb: Pick<BbPluginApi, "sdk">,
  options: ScriptOptionValues,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
): Promise<ScriptFileSource | undefined> {
  const scriptFile = options["script-file"];
  const hostOverride = options.host;
  if (scriptFile === undefined) {
    if (hostOverride !== undefined) {
      throw cliError("--host requires --script-file.", "missing_required");
    }
    return undefined;
  }
  const path = resolveHostPath({ rootPath: ctx.cwd ?? "", path: scriptFile });
  if (path === null) {
    throw cliError(
      "Invalid --script-file path; relative paths need the invoking CLI cwd.",
      "invalid_value",
    );
  }
  const fileName = getHostPathBasename(path);
  if (!fileName) {
    throw cliError(`--script-file must name a file: ${path}`, "invalid_value");
  }
  const hostId = await resolveScriptFileHostId(bb, ctx, hostOverride);
  const file = await bb.sdk.files.read({
    ...(hostId !== undefined ? { hostId } : {}),
    path,
  });
  if (file.contentEncoding !== "utf8") {
    throw cliError(`--script-file is not UTF-8 text: ${path}`, "invalid_value");
  }
  return { path, fileName, hostId, content: file.content };
}

type BuiltExecution = {
  execution: ResolvedCreateAutomationInput["execution"];
  scriptSource?: ScriptFileSource;
};

async function buildExecution(
  bb: Pick<BbPluginApi, "sdk">,
  options: ExecutionOptionValues,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
  defaultPermissionMode?: PermissionMode,
): Promise<BuiltExecution> {
  const prompt = options.prompt;
  const script = options.script;
  const scriptFile = options["script-file"];
  const hasAgent = prompt !== undefined;
  const hasScript = script !== undefined || scriptFile !== undefined;
  if (hasAgent && hasScript) {
    throw cliError(
      "Provide either agent flags (--prompt) or script flags (--script/--script-file), not both.",
      "unexpected_argument",
    );
  }
  if (
    hasAgent &&
    (options.interpreter !== undefined ||
      options.timeout !== undefined ||
      options["env-json"] !== undefined ||
      options["working-directory"] !== undefined)
  ) {
    throw cliError(
      "Agent automations do not accept --interpreter, --timeout, --env-json, or --working-directory.",
      "unexpected_argument",
    );
  }
  if (!hasAgent && !hasScript) {
    throw cliError(
      "Provide an execution mode: agent (--prompt --provider --model) or script (--script-file <path> or --script <inline>).",
      "missing_required",
    );
  }
  if (hasAgent) {
    const provider = options.provider;
    const model = options.model;
    if (!provider || !model) {
      throw cliError(
        "Agent automations require --provider and --model alongside --prompt.",
        "missing_required",
      );
    }
    validateAgentTargetOptions(options);
    const environment = await buildAgentEnvironment(bb, options, ctx);
    const serviceTier = options["service-tier"];
    return {
      execution: {
        mode: "agent",
        prompt,
        providerId: provider,
        model,
        reasoningLevel: options.reasoning ?? "medium",
        ...(serviceTier === undefined ? {} : { serviceTier }),
        permissionMode: await resolvePermissionMode(
          bb,
          provider,
          options["permission-mode"],
          providerRoutingForEnvironment(environment),
          defaultPermissionMode,
        ),
        environment,
        ...(options["target-thread"]
          ? { targetThreadId: options["target-thread"] }
          : {}),
      },
    };
  }
  if (
    options.provider !== undefined ||
    options.model !== undefined ||
    options.reasoning !== undefined ||
    options["service-tier"] !== undefined ||
    options["clear-service-tier"] === true ||
    options["permission-mode"] !== undefined ||
    options["target-thread"] !== undefined ||
    options.environment !== undefined ||
    options["new-environment"] !== undefined ||
    options["base-branch"] !== undefined
  ) {
    throw cliError(
      "Script automations do not accept agent execution flags.",
      "unexpected_argument",
    );
  }
  if (script !== undefined && scriptFile !== undefined) {
    throw cliError(
      "Provide exactly one of --script or --script-file.",
      "unexpected_argument",
    );
  }
  const timeoutMs = options.timeout;
  const env = parseScriptEnv(options["env-json"]);
  const workingDirectoryOption = options["working-directory"];
  const workingDirectory =
    workingDirectoryOption === undefined
      ? undefined
      : parseScriptWorkingDirectory(workingDirectoryOption);
  const scriptSource = await loadScriptFileSource(bb, options, ctx);
  const content = scriptSource ? scriptSource.content : script;
  if (!content) throw cliError("Missing script content.", "invalid_value");
  const interpreter =
    options.interpreter ??
    (scriptSource ? interpreterForPath(scriptSource.path) : undefined);
  return {
    execution: {
      mode: "script",
      script: content,
      ...(scriptSource ? { scriptFile: scriptSource.fileName } : {}),
      ...(interpreter ? { interpreter } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      timeoutMs: timeoutMs ?? AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS,
      ...(env ? { env } : {}),
    },
    ...(scriptSource ? { scriptSource } : {}),
  };
}

const SCRIPT_UPDATE_OPTION_NAMES = [
  "script",
  "script-file",
  "host",
  "interpreter",
  "timeout",
  "env-json",
  "working-directory",
] as const;

function hasAgentOptions(options: AgentOptionValues): boolean {
  return [
    options.prompt,
    options.provider,
    options.model,
    options.reasoning,
    options["service-tier"],
    options["clear-service-tier"] || undefined,
    options["permission-mode"],
    options["target-thread"],
    options.environment,
    options["new-environment"],
    options["base-branch"],
  ].some((value) => value !== undefined);
}

async function buildScriptExecutionUpdate(
  bb: Pick<BbPluginApi, "sdk">,
  options: ScriptOptionValues,
  ctx: Pick<PluginCliContext, "cwd" | "threadId">,
): Promise<{ update: ScriptExecutionUpdate; scriptSource?: ScriptFileSource }> {
  if (options.script !== undefined && options["script-file"] !== undefined) {
    throw cliError(
      "Provide exactly one of --script or --script-file.",
      "unexpected_argument",
    );
  }
  const env = parseScriptEnv(options["env-json"]);
  const workingDirectoryOption = options["working-directory"];
  const scriptSource = await loadScriptFileSource(bb, options, ctx);
  const update: ScriptExecutionUpdate = {};
  if (scriptSource !== undefined) {
    update.script = scriptSource.content;
    update.scriptFile = scriptSource.fileName;
  } else if (options.script !== undefined) {
    update.script = options.script;
  }
  if (update.script === "") {
    throw cliError("Missing script content.", "invalid_value");
  }
  if (options.interpreter !== undefined) {
    update.interpreter = options.interpreter;
  }
  if (options.timeout !== undefined) update.timeoutMs = options.timeout;
  if (env !== undefined) update.env = env;
  if (workingDirectoryOption !== undefined) {
    update.workingDirectory = parseScriptWorkingDirectory(
      workingDirectoryOption,
    );
  }
  return { update, ...(scriptSource ? { scriptSource } : {}) };
}

async function buildAgentExecutionUpdate(
  bb: Pick<BbPluginApi, "sdk">,
  options: AgentOptionValues,
  ctx: Pick<PluginCliContext, "threadId">,
): Promise<AgentExecutionUpdate | undefined> {
  if (!hasAgentOptions(options)) return undefined;

  validateAgentTargetOptions(options);
  const update: AgentExecutionUpdate = {};
  if (options.prompt !== undefined) {
    update.prompt = requireOptionValue("prompt", options.prompt);
  }
  if (options.provider !== undefined) {
    update.providerId = requireOptionValue("provider", options.provider);
  }
  if (options.model !== undefined) {
    update.model = requireOptionValue("model", options.model);
  }
  if (options.reasoning !== undefined) {
    update.reasoningLevel = options.reasoning;
  }
  const serviceTier = options["service-tier"];
  if (options["clear-service-tier"]) {
    update.serviceTier = null;
  } else if (serviceTier !== undefined) {
    update.serviceTier = serviceTier;
  }
  if (options["permission-mode"] !== undefined) {
    update.permissionMode = options["permission-mode"];
  }
  if (options["target-thread"] !== undefined) {
    update.target = {
      type: "target-thread",
      threadId: requireOptionValue("target-thread", options["target-thread"]),
    };
  } else if (
    options.environment !== undefined ||
    options["new-environment"] !== undefined
  ) {
    update.target = {
      type: "environment",
      environment: await buildAgentEnvironment(bb, options, ctx),
    };
  }
  return update;
}

function hasEventOptions(options: EventOptionValues): boolean {
  return (
    options.on !== undefined ||
    options.hook !== undefined ||
    options.event.length > 0 ||
    options.pick.length > 0 ||
    options["max-runs-per-hour"] !== undefined ||
    options.verification !== undefined ||
    options["allow-full-access-for-events"] ||
    options["revoke-full-access-for-events"] ||
    hasEventFilterFlags(options)
  );
}

async function buildCreateEventTrigger(
  hooks: HookService,
  options: ScheduleOptionValues & EventOptionValues & { name: string },
  projectId: string,
  ctx: Pick<PluginCliContext, "threadId">,
): Promise<BuiltEventTrigger | undefined> {
  if (options.on === undefined) return undefined;
  return buildEventTrigger({
    hooks,
    options,
    projectId,
    automationName: options.name,
    ctx,
  });
}

async function buildUpdateRequest(
  bb: Pick<BbPluginApi, "sdk">,
  service: Pick<AutomationService, "get">,
  hooks: HookService,
  options: UpdateOptionValues,
  automationId: string,
  ctx: Pick<PluginCliContext, "cwd" | "projectId" | "threadId">,
): Promise<{
  request: UpdateAutomationInput;
  scriptSource?: ScriptFileSource;
  createdHook?: BuiltEventTrigger["createdHook"];
}> {
  const projectId = requireProjectId(options.project, ctx);
  const request: UpdateAutomationInput = { projectId, automationId };
  if (ctx.threadId !== undefined) request.callerThreadId = ctx.threadId;
  if (options.name !== undefined) request.name = options.name;
  let createdHook: BuiltEventTrigger["createdHook"];
  let willBeEvent: boolean | undefined;
  if (
    options.cron !== undefined ||
    options.timezone !== undefined ||
    options.at !== undefined ||
    options.in !== undefined
  ) {
    request.trigger = buildTrigger(options);
    willBeEvent = false;
  } else if (hasEventOptions(options)) {
    const found = await service.get({ projectId, automationId });
    const currentTrigger = "trigger" in found ? found.trigger : undefined;
    if (options.on === undefined && currentTrigger?.triggerType !== "event") {
      throw cliError(
        "Event flags need --on webhook|github, or an automation that already starts on events.",
        "missing_required",
      );
    }
    const built = await buildEventTrigger({
      hooks,
      options,
      projectId,
      automationName: options.name ?? found.name,
      ctx,
      ...(options.on === undefined && currentTrigger?.triggerType === "event"
        ? { current: currentTrigger }
        : {}),
    });
    request.trigger = built.trigger;
    createdHook = built.createdHook;
    willBeEvent = true;
  }
  let scriptSource: ScriptFileSource | undefined;
  const replacesAgentExecution =
    options.prompt !== undefined &&
    options.provider !== undefined &&
    options.model !== undefined;
  const hasScriptOptions = SCRIPT_UPDATE_OPTION_NAMES.some(
    (name) => options[name] !== undefined,
  );
  if (replacesAgentExecution) {
    if (willBeEvent === undefined) {
      const found = await service.get({ projectId, automationId });
      willBeEvent = "trigger" in found && found.trigger.triggerType === "event";
    }
    const built = await buildExecution(
      bb,
      options,
      ctx,
      willBeEvent ? "accept-edits" : undefined,
    );
    request.execution = built.execution;
  } else if (hasScriptOptions) {
    if (hasAgentOptions(options)) {
      throw cliError(
        "Cannot combine agent execution flags with script flags.",
        "unexpected_argument",
      );
    }
    const current = await service.get({ projectId, automationId });
    if ("execution" in current && current.execution.mode === "agent") {
      const built = await buildExecution(bb, options, ctx);
      request.execution = built.execution;
      scriptSource = built.scriptSource;
    } else {
      const built = await buildScriptExecutionUpdate(bb, options, ctx);
      request.script = built.update;
      scriptSource = built.scriptSource;
    }
  } else {
    const agentUpdate = await buildAgentExecutionUpdate(bb, options, ctx);
    if (agentUpdate !== undefined) {
      request.agent = agentUpdate;
    }
  }
  if (
    request.name === undefined &&
    request.trigger === undefined &&
    request.execution === undefined &&
    request.agent === undefined &&
    request.script === undefined
  ) {
    throw cliError(
      "No changes requested. Provide --name, schedule flags, a complete agent/script execution, or partial agent/script update flags.",
      "missing_required",
    );
  }
  return {
    request,
    ...(scriptSource ? { scriptSource } : {}),
    ...(createdHook ? { createdHook } : {}),
  };
}

function formatAutomationTrigger(automation: AutomationResponse): string {
  if (automation.trigger.triggerType === "event") {
    const { events } = automation.trigger;
    return events.length === 0 ? "on event" : `on event: ${events.join(", ")}`;
  }
  if (automation.trigger.triggerType === "once") {
    return `once at ${formatTimestamp(automation.trigger.runAt)}`;
  }
  return `${automation.trigger.cron} (${automation.trigger.timezone})`;
}

type PrintableAutomation =
  | AutomationDetailResponse
  | Extract<AutomationReadProblem, { problem: "missing-agent-prompt" }>;

function printAutomation(
  automation: PrintableAutomation,
  status?: string,
): string {
  const lines = [
    "",
    `  ID:        ${automation.id}`,
    `  Name:      ${automation.name}`,
    ...(status === undefined ? [] : [`  Status:    ${status}`]),
    `  Enabled:   ${automation.enabled ? "yes" : "no"}`,
    `  Mode:      ${automation.execution.mode}`,
    `  Schedule:  ${formatAutomationTrigger(automation)}`,
    `  Next run:  ${formatTimestamp(automation.nextRunAt)}`,
    `  Last run:  ${formatTimestamp(automation.lastRunAt)}`,
    `  Runs:      ${automation.runCount}`,
    `  Origin:    ${automation.origin}`,
  ];
  if (
    automation.execution.mode === "script" &&
    automation.execution.storedScriptPath !== undefined
  ) {
    lines.push(`  Script:    ${automation.execution.storedScriptPath}`);
  }
  if (automation.execution.mode === "script") {
    lines.push(
      `  Working dir: ${automation.execution.resolvedWorkingDirectory ?? "unavailable"}`,
    );
  }
  if (automation.execution.mode === "agent") {
    lines.push(
      `  Provider:  ${automation.execution.providerId}`,
      `  Model:     ${automation.execution.model}`,
      `  Reasoning: ${automation.execution.reasoningLevel}`,
      `  Tier:      ${automation.execution.serviceTier ?? "-"}`,
      `  Permission: ${automation.execution.permissionMode}`,
    );
  }
  if (automation.trigger.triggerType === "event") {
    const trigger = automation.trigger;
    lines.push(
      `  Hook:      ${trigger.hookId}`,
      `  Filters:   ${trigger.where.length === 0 ? "-" : trigger.where.map(formatWhere).join("; ")}`,
      `  Payload:   ${trigger.pick.length === 0 ? "whole payload" : trigger.pick.join(", ")} (up to ${trigger.maxPayloadBytes} bytes)`,
      `  Cap:       ${trigger.maxRunsPerHour} runs per hour`,
    );
    if (trigger.acknowledgeUntrustedInput) {
      lines.push("  Full access for events: acknowledged");
    }
  }
  if (automation.lastError) lines.push(`  Error:     ${automation.lastError}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function refreshScriptFileCommand(
  automation: AutomationDetailResponse,
  source: ScriptFileSource,
): string {
  const argv = [
    "bb",
    "automation",
    "update",
    automation.id,
    "--project",
    automation.projectId,
    "--script-file",
    source.path,
  ];
  if (source.hostId !== undefined) argv.push("--host", source.hostId);
  return argv.map(shellQuote).join(" ");
}

function printScriptFileSnapshotNote(
  automation: AutomationDetailResponse,
  source: ScriptFileSource | undefined,
): string {
  if (
    source === undefined ||
    automation.execution.mode !== "script" ||
    automation.execution.storedScriptPath === undefined
  ) {
    return "";
  }
  return [
    `Copied ${source.path}${source.hostId !== undefined ? ` (host ${source.hostId})` : ""}`,
    `    to ${automation.execution.storedScriptPath}`,
    "The automation runs this stored copy, a snapshot of the source file.",
    "Edits to the source file do not apply until you run:",
    `  ${refreshScriptFileCommand(automation, source)}`,
    "",
  ].join("\n");
}

function printAutomationProblem(automation: AutomationReadProblem): string {
  if (automation.problem === "missing-agent-prompt") {
    return printAutomation(automation, "Prompt required");
  }
  return (
    [
      "",
      `  ID:        ${automation.id}`,
      `  Name:      ${automation.name}`,
      "  Status:    Invalid data",
      "",
    ].join("\n") + "\n"
  );
}

function printAutomationTable(automations: AutomationReadResult[]): string {
  return table(
    ["ID", "Name", "Status", "On", "Schedule", "Next run", "Runs", "Origin"],
    automations.map((automation) =>
      "problem" in automation
        ? automation.problem === "missing-agent-prompt"
          ? [
              automation.id,
              automation.name,
              "Prompt required",
              automation.enabled ? "yes" : "no",
              formatAutomationTrigger(automation),
              formatTimestamp(automation.nextRunAt),
              String(automation.runCount),
              automation.origin,
            ]
          : [
              automation.id,
              automation.name,
              "Invalid data",
              "-",
              "-",
              "-",
              "-",
              "-",
            ]
        : [
            automation.id,
            automation.name,
            "-",
            automation.enabled ? "yes" : "no",
            formatAutomationTrigger(automation),
            formatTimestamp(automation.nextRunAt),
            String(automation.runCount),
            automation.origin,
          ],
    ),
  );
}

function printRunTable(runs: AutomationRunResponse[]): string {
  return table(
    ["ID", "Status", "Started", "Thread/Exit", "Detail"],
    runs.map((run) => [
      run.id,
      run.status,
      formatTimestamp(run.startedAt),
      run.threadId ?? (run.exitCode === null ? "-" : `exit ${run.exitCode}`),
      run.skipReason ?? run.error ?? "-",
    ]),
  );
}

export function registerAutomationCli(args: {
  bb: Pick<BbPluginApi, "cli" | "sdk">;
  service: AutomationService;
  hooks: HookService;
}): void {
  const { bb, service, hooks } = args;
  bb.cli.register(
    defineCli({
      name: "automation",
      summary: "Inspect and manage automations (scheduled agent/script runs)",
      description: DESCRIPTION,
      root: cliCommand({
        summary: "Show the automation commands",
        run: (input) => ({ exitCode: 0, stdout: input.help }),
      }),
      commands: {
        list: cliCommand({
          summary: "List automations for a project or a target thread",
          options: {
            project: {
              type: "string",
              placeholder: "id",
              description:
                "Project whose automations to list; required unless --target-thread is given",
            },
            "target-thread": {
              type: "string",
              placeholder: "thread-id",
              description:
                "List automations in any project that re-prompt this thread",
            },
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "at-most-one", options: ["project", "target-thread"] },
          ],
          run: async (input, ctx) => {
            const targetThreadId = input.options["target-thread"];
            const result = service.list(
              targetThreadId === undefined
                ? {
                    projectId: requireProjectId(input.options.project, ctx),
                  }
                : {
                    targetThreadId: requireOptionValue(
                      "target-thread",
                      targetThreadId,
                    ),
                  },
            );
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput(result)
                : result.length === 0
                  ? "No automations found\n"
                  : printAutomationTable(result),
            };
          },
        }),
        create: cliCommand({
          summary: "Create an automation",
          description:
            "Pick exactly one schedule flag and one execution mode: agent (--prompt --provider --model) or script (--script or --script-file).",
          options: {
            project: PROJECT_OPTION,
            name: {
              type: "string",
              placeholder: "name",
              required: true,
              description: "Display name, at most 200 characters",
            },
            disabled: {
              type: "boolean",
              description: "Create the automation paused",
            },
            ...SCHEDULE_OPTIONS,
            ...EVENT_OPTIONS,
            ...AGENT_OPTIONS,
            ...SCRIPT_OPTIONS,
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "exactly-one", options: ["cron", "at", "in", "on"] },
            { kind: "requires", option: "cron", needs: ["timezone"] },
            { kind: "requires", option: "timezone", needs: ["cron"] },
            ...EVENT_FLAG_CONSTRAINTS,
          ],
          run: async (input, ctx) => {
            const projectId = requireProjectId(input.options.project, ctx);
            const eventTrigger = await buildCreateEventTrigger(
              hooks,
              input.options,
              projectId,
              ctx,
            );
            try {
              const { execution, scriptSource } = await buildExecution(
                bb,
                input.options,
                ctx,
                eventTrigger === undefined ? undefined : "accept-edits",
              );
              const request: ResolvedCreateAutomationInput = {
                projectId,
                name: input.options.name,
                enabled: !input.options.disabled,
                trigger: eventTrigger?.trigger ?? buildTrigger(input.options),
                execution,
                origin: ctx.threadId ? "agent" : "human",
                ...(ctx.threadId ? { createdByThreadId: ctx.threadId } : {}),
              };
              const created = await service.create(request);
              const createdHook = eventTrigger?.createdHook;
              const withheld =
                createdHook !== undefined && ctx.threadId
                  ? secretWithheldMessage({
                      hookId: createdHook.hook.id,
                      projectId,
                    })
                  : undefined;
              const hook =
                createdHook === undefined
                  ? undefined
                  : await hooks.get({
                      projectId,
                      hookId: createdHook.hook.id,
                    });
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? jsonOutput(
                      createdHook === undefined
                        ? created
                        : withheld === undefined
                          ? { ...created, hook, secret: createdHook.secret }
                          : { ...created, hook, secretWithheld: withheld },
                    )
                  : `Automation created: ${created.id}\n${printAutomation(created)}${printScriptFileSnapshotNote(created, scriptSource)}${hook === undefined || createdHook === undefined ? "" : `New hook:${printHook(hook, withheld === undefined ? { secret: createdHook.secret, example: true } : { secretWithheld: withheld, example: true })}`}`,
              };
            } catch (error) {
              if (eventTrigger?.createdHook !== undefined) {
                await hooks
                  .delete({
                    projectId,
                    hookId: eventTrigger.createdHook.hook.id,
                  })
                  .catch(() => undefined);
              }
              throw error;
            }
          },
        }),
        show: cliCommand({
          summary: "Show automation details",
          positionals: [AUTOMATION_ID_POSITIONAL],
          options: { project: PROJECT_OPTION, json: JSON_OPTION },
          run: async (input, ctx) => {
            const found = await service.get({
              projectId: requireProjectId(input.options.project, ctx),
              automationId: input.positionals.automationId,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput(found)
                : "problem" in found
                  ? printAutomationProblem(found)
                  : printAutomation(found),
            };
          },
        }),
        update: cliCommand({
          summary: "Update automation configuration",
          description:
            "Patch an existing agent or script with any subset of its flags; omitted settings keep their values. --prompt --provider --model together replace the execution with a new agent, and script flags on an agent automation replace it with a script (--script/--script-file required).",
          positionals: [AUTOMATION_ID_POSITIONAL],
          options: {
            project: PROJECT_OPTION,
            name: {
              type: "string",
              placeholder: "name",
              description: "Replacement display name, at most 200 characters",
            },
            ...SCHEDULE_OPTIONS,
            ...EVENT_OPTIONS,
            ...AGENT_OPTIONS,
            ...SCRIPT_OPTIONS,
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "at-most-one", options: ["cron", "at", "in", "on"] },
            { kind: "requires", option: "cron", needs: ["timezone"] },
            { kind: "requires", option: "timezone", needs: ["cron"] },
          ],
          run: async (input, ctx) => {
            const { request, scriptSource, createdHook } =
              await buildUpdateRequest(
                bb,
                service,
                hooks,
                input.options,
                input.positionals.automationId,
                ctx,
              );
            let updated;
            try {
              updated = await service.update(request);
            } catch (error) {
              if (createdHook !== undefined) {
                await hooks
                  .delete({
                    projectId: request.projectId,
                    hookId: createdHook.hook.id,
                  })
                  .catch(() => undefined);
              }
              throw error;
            }
            const withheld =
              createdHook !== undefined && ctx.threadId
                ? secretWithheldMessage({
                    hookId: createdHook.hook.id,
                    projectId: request.projectId,
                  })
                : undefined;
            const hook =
              createdHook === undefined
                ? undefined
                : await hooks.get({
                    projectId: request.projectId,
                    hookId: createdHook.hook.id,
                  });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput(
                    createdHook === undefined
                      ? updated
                      : withheld === undefined
                        ? { ...updated, hook, secret: createdHook.secret }
                        : { ...updated, hook, secretWithheld: withheld },
                  )
                : `Automation ${updated.id} updated\n${printAutomation(updated)}${printScriptFileSnapshotNote(updated, scriptSource)}${hook === undefined || createdHook === undefined ? "" : `New hook:${printHook(hook, withheld === undefined ? { secret: createdHook.secret, example: true } : { secretWithheld: withheld, example: true })}`}`,
            };
          },
        }),
        pause: cliCommand({
          summary: "Pause an automation",
          positionals: [AUTOMATION_ID_POSITIONAL],
          options: { project: PROJECT_OPTION, json: JSON_OPTION },
          run: async (input, ctx) => {
            const updated = service.pause({
              projectId: requireProjectId(input.options.project, ctx),
              automationId: input.positionals.automationId,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput(updated)
                : `Automation ${updated.id} paused\n`,
            };
          },
        }),
        resume: cliCommand({
          summary: "Resume an automation",
          positionals: [AUTOMATION_ID_POSITIONAL],
          options: { project: PROJECT_OPTION, json: JSON_OPTION },
          run: async (input, ctx) => {
            const updated = service.resume({
              projectId: requireProjectId(input.options.project, ctx),
              automationId: input.positionals.automationId,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput(updated)
                : `Automation ${updated.id} resumed\n`,
            };
          },
        }),
        run: cliCommand({
          summary: "Run an automation now",
          positionals: [AUTOMATION_ID_POSITIONAL],
          options: {
            project: PROJECT_OPTION,
            "idempotency-key": {
              type: "string",
              placeholder: "key",
              description:
                "Reuse the run started by an earlier call with this key, at most 200 characters",
            },
            json: JSON_OPTION,
          },
          run: async (input, ctx) => {
            const idempotencyKey = input.options["idempotency-key"];
            const result = await service.run({
              projectId: requireProjectId(input.options.project, ctx),
              automationId: input.positionals.automationId,
              ...(idempotencyKey ? { idempotencyKey } : {}),
            });
            const threadLine = result.run.threadId
              ? `Thread: ${result.run.threadId}\n`
              : "";
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput(result)
                : `Run started: ${result.run.id}\n${threadLine}`,
            };
          },
        }),
        runs: cliCommand({
          summary: "List automation runs",
          positionals: [AUTOMATION_ID_POSITIONAL],
          options: {
            project: PROJECT_OPTION,
            limit: {
              type: "integer",
              min: 1,
              max: AUTOMATION_RUNS_LIMIT_MAX,
              default: AUTOMATION_RUNS_LIMIT_DEFAULT,
              description: "How many recent runs to read",
            },
            output: {
              type: "string",
              placeholder: "runId",
              description:
                "Print only this run's captured output; it must be inside --limit",
            },
            json: JSON_OPTION,
          },
          run: async (input, ctx) => {
            const result = service.runs({
              projectId: requireProjectId(input.options.project, ctx),
              automationId: input.positionals.automationId,
              limit: input.options.limit,
            });
            const outputRunId = input.options.output;
            if (outputRunId) {
              const run = result.runs.find(
                (candidate) => candidate.id === outputRunId,
              );
              if (!run) {
                throw cliError(
                  `Run ${outputRunId} not found in returned runs. Increase --limit if it is older.`,
                  "not_found",
                );
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? jsonOutput(run)
                  : `${run.output ?? ""}\n`,
              };
            }
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput(result)
                : result.runs.length === 0
                  ? "No runs found\n"
                  : printRunTable(result.runs),
            };
          },
        }),
        ...createEventCommands({ hooks }),
        delete: cliCommand({
          summary: "Delete an automation",
          positionals: [AUTOMATION_ID_POSITIONAL],
          options: {
            project: PROJECT_OPTION,
            yes: {
              type: "boolean",
              description: "Required. Confirms the automation is deleted",
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
            const projectId = requireProjectId(input.options.project, ctx);
            const automationId = input.positionals.automationId;
            await service.delete({ projectId, automationId });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, id: automationId })
                : `Automation ${automationId} deleted\n`,
            };
          },
        }),
      },
    }),
  );
}
