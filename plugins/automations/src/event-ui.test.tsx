// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type {
  AutomationEventDetail,
  AutomationEventSummary,
  AutomationEventTrigger,
  AutomationHookResponse,
  AutomationResponse,
  AutomationRunResponse,
  HookTestResponse,
} from "./rpc-types.js";
import { EventDeliveriesList } from "../event-deliveries.js";
import { EventTriggerCard } from "../event-trigger-card.js";
import {
  EVENT_RUN_NOW_REASON,
  formatAutomationTrigger,
  formatScheduleStatusLabel,
} from "../lib/format-schedule.js";
import { AutomationOverviewView } from "../overview-view.js";

installTestPluginRuntime();
afterEach(cleanup);

const TRIGGER: AutomationEventTrigger = {
  triggerType: "event",
  hookId: "hk_aaaaaaaaaaaaaaaaaaaaaa",
  events: ["issues.labeled", "issues.opened"],
  where: [
    { path: "_bb.label", op: "=", values: ["bug"] },
    { path: "_bb.actor", op: "in", values: ["alice", "bob"] },
  ],
  pick: ["issue.title"],
  maxRunsPerHour: 20,
  maxPayloadBytes: 16_384,
  acknowledgeUntrustedInput: false,
};

const PATH_RULE =
  "Forward only /api/v1/plugins/automations/http/webhook to this server and answer 404 for every other path: the rest of the bb API has no login. Set the proxy's upstream Host header to this server's own address (for example 127.0.0.1), because bb refuses other host names.";
const PUBLIC_WARNING = `Anyone on the internet can reach this address. ${PATH_RULE}`;

function hook(
  overrides: Partial<AutomationHookResponse> = {},
): AutomationHookResponse {
  return {
    id: TRIGGER.hookId,
    projectId: "proj_1",
    source: "github",
    verification: "hmac",
    name: "Widgets",
    secretVersion: 1,
    rejectedCount: 0,
    lastRejectedAt: null,
    createdAt: 1,
    rotatedAt: null,
    url: "https://bb.example.com/api/v1/plugins/automations/http/webhook?hook=hk_aaaaaaaaaaaaaaaaaaaaaa",
    urlSource: "setting",
    urlScope: "public",
    urlWarning: PUBLIC_WARNING,
    automationIds: ["auto_1"],
    ...overrides,
  };
}

function card(props: Partial<Parameters<typeof EventTriggerCard>[0]> = {}) {
  return (
    <EventTriggerCard
      trigger={TRIGGER}
      permissionMode="accept-edits"
      hook={hook()}
      hookError={null}
      disabled={false}
      onRotate={async () => ({
        hook: hook({ secretVersion: 2 }),
        secret: "s3cret-value",
      })}
      onTest={async () => TEST_RESULT}
      {...props}
    />
  );
}

const TEST_RESULT: HookTestResponse = {
  dryRun: true,
  kind: "call",
  deliveryId: null,
  outcomes: [
    {
      automationId: "auto_1",
      outcome: "queued",
      runId: null,
      reason: null,
      updatedAt: 1,
    },
  ],
  promptPreviews: [{ automationId: "auto_1", prompt: "PREVIEW-PROMPT-TEXT" }],
};

describe("event trigger card", () => {
  it("shows the URL, where it came from, the filters and the cap", () => {
    const { container } = render(card());
    expect(container.querySelector("[data-event-url]")?.textContent).toBe(
      hook().url,
    );
    expect(
      container.querySelector("[data-event-url-source]")?.textContent,
    ).toBe("From the webhookBaseUrl plugin setting");
    expect(
      screen.getByText("GitHub signature (X-Hub-Signature-256)"),
    ).toBeTruthy();
    expect(screen.getByText("issues.labeled")).toBeTruthy();
    expect(screen.getByText("_bb.label = bug")).toBeTruthy();
    expect(screen.getByText("_bb.actor in alice, bob")).toBeTruthy();
    expect(screen.getByText("issue.title")).toBeTruthy();
    expect(screen.getByText(/20 runs per hour/u)).toBeTruthy();
  });

  it("always states the path-only rule next to the URL, and never names bb Connect as the fix", () => {
    const loopback = `Only this machine can reach this address. To receive events from elsewhere, put a reverse proxy or tunnel in front. ${PATH_RULE} Then set the webhookBaseUrl plugin setting to the proxy's public address. The automations skill has Caddy, nginx and cloudflared rules.`;
    const { container } = render(
      card({
        hook: hook({
          url: "http://127.0.0.1:3000/api/v1/plugins/automations/http/webhook?hook=hk_x",
          urlSource: "loopback",
          urlScope: "loopback",
          urlWarning: loopback,
        }),
      }),
    );
    const note = container.querySelector("[data-event-url-warning]");
    expect(note?.textContent).toContain(
      "Only this machine can reach this address",
    );
    expect(note?.textContent).toContain("Forward only /api/v1/plugins/automations/http/webhook");
    expect(note?.textContent).toContain("answer 404 for every other path");
    expect(container.textContent).not.toMatch(/connect/iu);
    expect(
      container.querySelector("[data-event-url-source]")?.textContent,
    ).toBe("This machine's loopback address");
  });

  it("keeps the path-only note on a public address", () => {
    const { container } = render(card());
    const note = container.querySelector("[data-event-url-warning]");
    expect(note?.textContent).toContain("Anyone on the internet can reach this address");
    expect(note?.textContent).toContain("answer 404 for every other path");
  });

  it("rotates after a confirmation and shows the new secret once", async () => {
    const onRotate = vi.fn(async () => ({
      hook: hook({ secretVersion: 2 }),
      secret: "s3cret-value",
    }));
    const { container } = render(card({ onRotate }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    expect(onRotate).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/stops working at once/u)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Rotate secret" }),
    );
    await waitFor(() =>
      expect(
        document.querySelector("[data-event-secret]")?.textContent,
      ).toContain("s3cret-value"),
    );
    expect(onRotate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(document.querySelector("[data-event-secret]")).toBeNull(),
    );
    expect(container.textContent).not.toContain("s3cret-value");
  });

  it("previews the prompt for a sample payload and rejects invalid JSON", async () => {
    const onTest = vi.fn(async () => TEST_RESULT);
    render(card({ onTest }));
    fireEvent.click(screen.getByRole("button", { name: "Send test event" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Payload (JSON)"), {
      target: { value: "{not json" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Preview prompt" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "not valid JSON",
    );
    expect(onTest).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Payload (JSON)"), {
      target: { value: '{"a": 1}' },
    });
    fireEvent.change(within(dialog).getByLabelText("Event kind"), {
      target: { value: "issues.labeled" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Preview prompt" }),
    );
    expect(
      (await within(dialog).findByText("PREVIEW-PROMPT-TEXT")).closest(
        "[data-event-prompt-preview]",
      ),
    ).toBeTruthy();
    expect(onTest).toHaveBeenCalledWith({
      payload: { a: 1 },
      kind: "issues.labeled",
      send: false,
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send sample" }),
    );
    await waitFor(() =>
      expect(onTest).toHaveBeenLastCalledWith({
        payload: { a: 1 },
        kind: "issues.labeled",
        send: true,
      }),
    );
  });

  it("warns when full access is on for events", () => {
    const { container, rerender } = render(card({ permissionMode: "full" }));
    expect(
      container.querySelector("[data-event-full-access]")?.textContent,
    ).toContain("not acknowledged");
    rerender(
      card({
        permissionMode: "full",
        trigger: { ...TRIGGER, acknowledgeUntrustedInput: true },
      }),
    );
    expect(
      container.querySelector("[data-event-full-access]")?.textContent,
    ).toContain("(acknowledged)");
    rerender(card({ permissionMode: "accept-edits" }));
    expect(container.querySelector("[data-event-full-access]")).toBeNull();
  });

  it("reports a hook that cannot be read", () => {
    render(card({ hook: null, hookError: "Hook not found" }));
    expect(
      screen.getByText("The hook could not be read: Hook not found"),
    ).toBeTruthy();
  });
});

function summary(
  id: string,
  outcome: AutomationEventSummary["outcomes"][number]["outcome"],
  overrides: Partial<AutomationEventSummary> = {},
): AutomationEventSummary {
  return {
    id,
    hookId: TRIGGER.hookId,
    source: "github",
    kind: "issues.labeled",
    receivedAt: 1_800_000_000_000,
    sample: false,
    payloadBytes: 10,
    outcomes: [
      {
        automationId: "auto_1",
        outcome,
        runId: null,
        reason: outcome === "filtered" ? "filter x did not match" : null,
        updatedAt: 1,
      },
    ],
    ...overrides,
  };
}

const state = (events: AutomationEventSummary[]) => ({
  events,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
  loadMore: () => {},
  retry: () => {},
});

describe("event deliveries list", () => {
  it("labels each outcome and links the thread of a started delivery", () => {
    const onOpenThread = vi.fn();
    const run = {
      id: "arun_1",
      automationId: "auto_1",
      runMode: "agent",
      threadId: "thr_1",
      status: "running",
      trigger: "event",
      eventDeliveryId: "evd_1",
      skipReason: null,
      error: null,
      output: null,
      exitCode: null,
      scheduledFor: 1,
      startedAt: 1,
      finishedAt: null,
    } satisfies AutomationRunResponse;
    render(
      <EventDeliveriesList
        state={state([
          summary("evd_1", "started"),
          summary("evd_2", "filtered"),
          summary("evd_3", "rate_limited"),
          summary("evd_4", "queued", { sample: true }),
        ])}
        automationId="auto_1"
        runs={[run]}
        loadDetail={async () => {
          throw new Error("not used");
        }}
        onOpenThread={onOpenThread}
      />,
    );
    for (const label of [
      "Started",
      "Filtered out",
      "Rate limited",
      "Queued",
      "Sample",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("filter x did not match")).toBeTruthy();
    const links = screen.getAllByRole("button", {
      name: "Open the thread of this delivery",
    });
    expect(links).toHaveLength(1);
    fireEvent.click(links[0]!);
    expect(onOpenThread).toHaveBeenCalledWith("thr_1");
  });

  it("loads the payload and the prompt when a delivery is opened", async () => {
    const loadDetail = vi.fn(async (): Promise<AutomationEventDetail> => ({
      ...summary("evd_1", "started"),
      payload: { issue: { title: "Crash" } },
      promptPreviews: [
        { automationId: "auto_1", prompt: "THE-RENDERED-PROMPT" },
      ],
    }));
    render(
      <EventDeliveriesList
        state={state([summary("evd_1", "started")])}
        automationId="auto_1"
        runs={[]}
        loadDetail={loadDetail}
        onOpenThread={() => {}}
      />,
    );
    expect(loadDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await screen.findByText("THE-RENDERED-PROMPT");
    expect(
      document.querySelector("[data-event-delivery-detail]")?.textContent,
    ).toContain('"title": "Crash"');
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it("shows empty and error states", () => {
    const { container, rerender } = render(
      <EventDeliveriesList
        state={state([])}
        automationId="auto_1"
        runs={[]}
        loadDetail={async () => {
          throw new Error("unused");
        }}
        onOpenThread={() => {}}
      />,
    );
    expect(
      container.querySelector('[data-event-deliveries-state="empty"]'),
    ).toBeTruthy();
    const retry = vi.fn();
    rerender(
      <EventDeliveriesList
        state={{ ...state([]), error: "boom", retry }}
        automationId="auto_1"
        runs={[]}
        loadDetail={async () => {
          throw new Error("unused");
        }}
        onOpenThread={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });
});

const EVENT_AUTOMATION: AutomationResponse = {
  id: "auto_1",
  projectId: "proj_1",
  name: "Triage bugs",
  enabled: true,
  trigger: TRIGGER,
  execution: {
    mode: "agent",
    prompt: "Triage it.",
    providerId: "codex",
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "accept-edits",
    environment: { type: "project-default" },
  },
  origin: "human",
  createdByThreadId: null,
  nextRunAt: null,
  lastRunAt: null,
  runCount: 0,
  lastRunStatus: null,
  lastRunThreadId: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("event automation labels", () => {
  it("labels the trigger and the status without a next run", () => {
    expect(formatAutomationTrigger(TRIGGER)).toBe(
      "On issues.labeled, issues.opened",
    );
    expect(formatAutomationTrigger({ ...TRIGGER, events: [] })).toBe(
      "On any event",
    );
    expect(
      formatAutomationTrigger({ ...TRIGGER, events: ["a", "b", "c", "d"] }),
    ).toBe("On a, b +2");
    expect(formatScheduleStatusLabel(EVENT_AUTOMATION)).toBe(
      "Waiting for events",
    );
    expect(
      formatScheduleStatusLabel({ ...EVENT_AUTOMATION, enabled: false }),
    ).toBe("Paused");
  });

  it("disables Run now in the overview row and says why", () => {
    render(
      <AutomationOverviewView
        entries={[
          {
            automation: EVENT_AUTOMATION,
            project: { id: "proj_1", name: "Project" },
          },
        ]}
        error={null}
        onRetry={() => {}}
        onOpenDetail={() => {}}
        onEnabledChange={async () => {}}
        onRunNow={async () => {}}
        onDelete={() => {}}
        onCreateViaChat={() => {}}
        activeMode="installed"
        onModeChange={() => {}}
      />,
    );
    expect(screen.getByText("On issues.labeled, issues.opened")).toBeTruthy();
    expect(screen.getByText("Waiting for events")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Trigger" })).toBeTruthy();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Triage bugs actions" }),
    );
    expect(
      screen
        .getByRole("menuitem", { name: "Run now" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(EVENT_RUN_NOW_REASON).toContain("Send test event");
  });
});
