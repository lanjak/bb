---
name: automations
description: "Schedule or manage recurring and one-shot BB agent or script automations."
---

# Automations

An automation is a scheduled task, or a task that starts when a signed webhook
arrives (see Event triggers). When due it runs in one of two modes:

agent Spawn a thread or re-prompt a target thread with a configured prompt.
script Run a stored server-side script and capture stdout/stderr/exit.

Use the top-level `bb automation` command. The CLI routes it to this plugin.

Pass `--project` explicitly for every automation command. Inside a thread, automations are stamped origin `agent` and record the creating thread automatically. Threads created by automations cannot create automations, and neither can a thread while an automation run is executing in it; once that run finishes, the thread can create automations again.

Personal supports automations with `--project proj_personal`. Use `bb project list --include-personal --json` to include it in discovery; an empty default project list does not mean Personal is unavailable.

Choosing a mode:

Use `script` when the output is fully determined by code: watchdogs, threshold alerts, health checks, heartbeats, and API pollers with a fixed output shape. Scripts run on the bb server. New standard-project scripts use the server-host project source when one exists; Personal and projects without one run in the plugin's shared script storage directory. Existing scripts without a saved policy also run there. Use `--working-directory automation-storage|project|<absolute-server-path>` to select the policy. Script automations do not have an environment field and do not accept environment flags.

Design the script to print nothing when there is nothing to report: an exit-0 run with empty stdout/stderr, or a last non-empty line of `{"wakeAgent": false}`, is recorded as a skipped silent tick. Any other output is captured; non-zero exit or timeout is recorded as a failed run.

Use `agent` when the run needs reasoning: summarize a feed, pick interesting items, draft a human-friendly message, or branch on content.

Creating:

```bash
bb automation create --project <id> --name "..." [schedule flags] [mode flags]
```

For creation flags and mode-specific defaults, read
[references/creation.md](references/creation.md).

Read `references/script-runtime.md` before you use a script file, depend on
injected variables, or diagnose retries, timeouts, restarts, and silent runs.

Event triggers:

```bash
bb automation create --project <id> --name "..." --on webhook|github [event flags] [mode flags]
bb automation hook list|show|create|rotate|test|delete ...
bb automation events <automationId|hookId> --project <id>
bb automation event show <deliveryId> --project <id>
```

Event runs default to `accept-edits`, are capped at 20 runs per hour, are never re-run by
Automations, and receive the payload as fenced data before the owner's prompt. Read
[references/events.md](references/events.md) before you create one, choose filters, set up a
sender, or allow full access. It never needs bb Connect. The webhook URL is built from the
`webhookBaseUrl` plugin setting, then `BB_APP_URL`, then loopback.

Never expose the whole bb server to receive events: its API has no login. A proxy or tunnel must
forward only `/api/v1/plugins/automations/http/webhook`, answer 404 for every other path, and set
the upstream `Host` header to the server's own address. events.md has tested Caddy, nginx and
cloudflared rules. Inside a thread the CLI withholds a new hook's secret (a thread's transcript goes
to a model provider); ask the user to run `bb automation hook rotate <hookId> --project <id> --yes`
in their terminal, or to use Rotate secret on the Trigger card.

Managing:

```bash
bb automation list --project <id>
bb automation list --target-thread <threadId>
bb automation show <automationId> --project <id>
bb automation update <automationId> --project <id> [--name <name>] [schedule flags] [partial agent or script flags | complete execution flags]
bb automation pause <automationId> --project <id>
bb automation resume <automationId> --project <id>
bb automation run <automationId> --project <id> [--idempotency-key <key>]   # not for event automations; use hook test
bb automation runs <automationId> --project <id> [--limit <count>] [--output <runId>]
bb automation delete <automationId> --project <id> --yes
```

`list --target-thread` returns automations in any project that re-prompt that
thread; the thread's Info tab shows the same list. It does not include
automations the thread merely created.

For partial updates, mode replacement, execution targets, or damaged records,
read [references/updates.md](references/updates.md). Every command supports `--json`.

`bb automation <command> --help` prints that command's exact arguments, options,
accepted values, and rules. Unknown commands, unknown options, and stray
arguments are rejected rather than ignored, and a failure under `--json` also
prints a `{"ok":false,"error":{"code","message","hint"}}` envelope on stdout.
