Schedule work once or on a repeat, and let bb run it while you do something else. An automation can start an agent thread with a prompt, or run a stored script on the bb server.

## What you get

- An Automations panel in the sidebar. Create, edit, pause, resume, and run automations there. Each automation shows its run history.
- Event triggers. An automation can start when a signed webhook arrives, from a script, a CI job or a GitHub repository webhook, instead of on a clock. Each gets a webhook URL on your bb server, filters on the payload, a deliveries list, and a hard cap of runs per hour. It does not need bb Connect.
- Two schedule types. Use a cron expression with a timezone for repeating work. Use a date, or a delay such as `2h`, for one-shot work.
- Agent mode. Pick the provider, model, reasoning level, and permission mode. Start a new thread, re-prompt an existing thread, or create a new worktree for each run.
- Script mode. Store a bash, sh, node, or python3 script. Each run records stdout, stderr, and the exit code. A script that prints nothing is recorded as a silent tick.

## For agents

Agents get the `automations` skill and the `bb automation` command: `create`, `list`, `show`, `update`, `pause`, `resume`, `run`, `runs`, and `delete`, plus `hook`, `events` and `event show` for event triggers. All commands accept `--json`. Threads that an automation starts cannot create automations.

Scripts run on the machine that hosts the bb server. New standard-project scripts use that host's project source when available; Personal and projects without one run in the plugin's shared script storage. Existing scripts run there until changed. A script can instead select an absolute server-host path, and its detail view shows the resolved directory. Agent runs use the providers you already have installed.

Event automations default to `accept-edits`, treat the payload as untrusted data in a fenced block before your prompt, and never re-run a failed event: provider retry owns failed turns. The webhook URL comes from the `webhookBaseUrl` plugin setting, then `BB_APP_URL`, then this machine's loopback address. To receive events from elsewhere, forward only `/api/v1/plugins/automations/http/webhook` through a proxy or tunnel and never the whole server, whose API has no login; the Trigger card and the automations skill say how.
