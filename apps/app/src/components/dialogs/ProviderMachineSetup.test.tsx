// @vitest-environment jsdom

import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type { SystemMachineProvider } from "@bb/server-contract";
import type { PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "@bb/shared-ui/dialog";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { sdk } from "@/lib/sdk";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { AddMachineContent } from "./AddMachineDialog";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: {
      delete: vi.fn(),
      experimental_create: vi.fn(),
      experimental_getEnrollmentCommand: vi.fn(),
      experimental_listProviders: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
    },
    system: { config: vi.fn() },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onChanged: vi.fn(() => () => {}),
    onConnected: vi.fn(() => () => {}),
    onResumed: vi.fn(() => () => {}),
    onConnectionStateChange: vi.fn(() => () => {}),
    getConnectionState: vi.fn(() => "connected"),
  },
}));

const provider = (
  overrides: Partial<SystemMachineProvider>,
): SystemMachineProvider => ({
  id: "ssh",
  displayName: "SSH",
  description: "Install bb over SSH.",
  icon: "Terminal",
  logoUrl: null,
  pluginId: "machine-ssh",
  inputs: {},
  acceptsEmptyInputs: false,
  supportsSuspend: false,
  supportsExecutor: true,
  ephemeral: false,
  ...overrides,
});

function SshControl({ onChange }: PluginMachineProviderInputsProps) {
  useEffect(() => {
    onChange({ status: "blocked", reason: "Check the connection first." });
  }, [onChange]);
  return (
    <button
      type="button"
      onClick={() =>
        onChange({ status: "ready", value: { destination: "build-box" } })
      }
    >
      Pick build-box
    </button>
  );
}

const creating = {
  ...makeHost({
    id: "host_new",
    name: "SSH abc123",
    status: "disconnected",
    machineProviderId: "ssh",
  }),
  lifecycle: {
    phase: "creating" as const,
    suspendedAt: null,
    message: "Installing bb on build-box",
    pendingLog: "Preparing machine enrollment\n",
    teardown: null,
  },
};

const config = makeSystemConfig();

beforeEach(() => {
  setPluginSlotRegistrations("machine-ssh", {
    homepageSections: [],
    settingsSections: [],
    navPanels: [],
    threadPanelActions: [],
    composerCustomizations: [],
    pendingInteractions: [],
    sidebarFooterActions: [],
    fileOpeners: [],
    messageDirectives: [],
    machineProviderInputs: [
      { machineProviderId: "ssh", component: SshControl },
    ],
  });
  vi.mocked(sdk.system.config).mockResolvedValue({
    ...config,
    serverAccess: {
      ...config.serverAccess,
      providers: [
        {
          id: "direct",
          displayName: "Manual",
          description: "Your own address.",
          pluginId: null,
          routeKind: "custom",
          availability: {
            status: "available",
            serverUrl: "https://bb.example.com",
          },
          urls: ["https://bb.example.com"],
        },
      ],
    },
  });
  vi.mocked(sdk.hosts.list).mockResolvedValue([]);
  vi.mocked(sdk.hosts.experimental_listProviders).mockResolvedValue([
    provider({}),
    provider({
      id: "cloud",
      displayName: "Cloud sandbox",
      pluginId: "machine-ssh",
      ephemeral: true,
    }),
  ]);
  vi.mocked(sdk.hosts.experimental_getEnrollmentCommand).mockResolvedValue(
    null,
  );
  vi.mocked(sdk.hosts.delete).mockResolvedValue({
    ok: true,
    progress: "complete",
    warnings: [],
  });
});

afterEach(() => {
  cleanup();
  removePluginSlotRegistrations("machine-ssh");
  vi.clearAllMocks();
});

function renderDialog() {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter>
      <Dialog open modal={false}>
        <DialogContent>
          <AddMachineContent onOpenChange={() => {}} />
        </DialogContent>
      </Dialog>
    </MemoryRouter>,
    { wrapper },
  );
}

describe("adding a machine through a provider", () => {
  it("offers persistent providers beside the manual command and creates with their inputs", async () => {
    vi.mocked(sdk.hosts.experimental_create).mockImplementation(async (args) =>
      args.machineProviderId === "ssh"
        ? creating
        : { ...creating, id: "host_manual", machineProviderId: "manual" },
    );
    vi.mocked(sdk.hosts.get).mockImplementation(async ({ hostId }) => ({
      ...creating,
      id: hostId,
      name: "build-box",
      status: "connected",
      lifecycle: {
        ...creating.lifecycle,
        phase: hostId === "host_new" ? "active" : "creating",
      },
      connectMachineId: null,
      threadStorageRootPath: null,
    }));
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Over SSH" }));
    expect(screen.queryByRole("button", { name: "Cloud sandbox" })).toBeNull();
    await waitFor(() =>
      expect(sdk.hosts.delete).toHaveBeenCalledWith({
        hostId: "host_manual",
      }),
    );
    const add = screen.getByRole("button", { name: "Add machine" });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Check the connection first.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Pick build-box" }));
    fireEvent.click(add);

    expect(await screen.findByText("build-box connected")).toBeDefined();
    expect(sdk.hosts.experimental_create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        machineProviderId: "ssh",
        inputs: { destination: "build-box" },
        wait: false,
      }),
    );
  });

  it("shows the setup log and failure, then returns to the form", async () => {
    vi.mocked(sdk.hosts.experimental_create).mockResolvedValue(creating);
    vi.mocked(sdk.hosts.get).mockResolvedValue({
      ...creating,
      lifecycle: {
        ...creating.lifecycle,
        phase: "removing",
        message: "Node.js 22.19 or newer is required on build-box",
      },
      connectMachineId: null,
      threadStorageRootPath: null,
    });
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Over SSH" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick build-box" }));
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Node.js 22.19 or newer is required on build-box",
    );
    expect(screen.getByLabelText("Setup log").textContent).toContain(
      "Preparing machine enrollment",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      (await screen.findByRole("button", { name: "Over SSH" })).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
  });
});
