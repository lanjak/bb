// @vitest-environment jsdom
import type { PluginMachineProviderInputsChange } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckReport } from "./app-contract.js";
import { PROVIDER_ID } from "./provider-id.js";

const app = await loadPluginApp(() => import("./app"));

const FINGERPRINT = `SHA256:${"k".repeat(43)}`;

const resolved = {
  user: "dev",
  hostname: "10.0.0.5",
  port: 22,
  proxyJump: "bastion",
  knownHostsName: "10.0.0.5",
  strictHostKeyChecking: false,
};

function report(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    inspection: {
      resolved,
      hostKey: {
        state: "unknown",
        fingerprint: FINGERPRINT,
        keyType: "ED25519",
      },
      message: null,
      facts: null,
    },
    blockers: [],
    notes: [],
    machineName: null,
    ...overrides,
  };
}

afterEach(cleanup);

function mount(check: () => CheckReport = () => report()) {
  const registration = app.machineProviderInputs.find(
    (candidate) => candidate.machineProviderId === PROVIDER_ID,
  );
  if (registration === undefined) throw new Error("SSH inputs not registered");
  const onChange = vi.fn<(next: PluginMachineProviderInputsChange) => void>();
  const slot = renderSlot(
    registration,
    { value: null, onChange, experimental_localHostId: "host_laptop" },
    {
      rpc: {
        connectionOptions: () => ({
          machines: [
            {
              id: "host_server",
              name: "server",
              connected: true,
              server: true,
            },
            {
              id: "host_laptop",
              name: "laptop",
              connected: true,
              server: false,
            },
          ],
          routes: [{ id: "direct", displayName: "Manual" }],
        }),
        configHosts: () => ({
          configPath: "/home/dev/.ssh/config",
          truncated: false,
          hosts: [{ alias: "build-box", machineName: "Build box" }],
        }),
        check,
      },
    },
  );
  const latest = () => onChange.mock.lastCall![0];
  return { slot, latest };
}

describe("SSH machine inputs", () => {
  it("connects from this device and blocks until the new host key is confirmed", async () => {
    const { slot, latest } = mount();
    await slot.findByText("In bb");
    expect(
      slot.getByRole("button", { name: "Connect from" }).textContent,
    ).toContain("laptop");
    expect(latest()).toEqual({
      status: "blocked",
      reason: "Choose a computer.",
    });

    fireEvent.change(slot.getByLabelText("Computer"), {
      target: { value: "dev@10.0.0.5" },
    });
    expect(latest()).toEqual({
      status: "blocked",
      reason: "Check the connection first.",
    });
    fireEvent.click(slot.getByRole("button", { name: "Check connection" }));
    await slot.findByText(FINGERPRINT);
    expect(latest()).toEqual({
      status: "blocked",
      reason: "Confirm the host key fingerprint.",
    });

    fireEvent.click(
      slot.getByRole("checkbox", {
        name: "I checked that this fingerprint belongs to dev@10.0.0.5",
      }),
    );
    await waitFor(() =>
      expect(latest()).toEqual({
        status: "ready",
        value: {
          via: "host_laptop",
          destination: "dev@10.0.0.5",
          keepRunning: true,
          hostKey: FINGERPRINT,
        },
      }),
    );

    fireEvent.change(slot.getByLabelText("Computer"), {
      target: { value: "dev@10.0.0.6" },
    });
    expect(latest()).toEqual({
      status: "blocked",
      reason: "Check the connection first.",
    });
    expect(slot.queryByText(FINGERPRINT)).toBeNull();
  });

  it("shows why a checked computer cannot be added", async () => {
    const { slot, latest } = mount(() =>
      report({
        inspection: {
          resolved,
          hostKey: {
            state: "trusted",
            fingerprint: FINGERPRINT,
            keyType: "ED25519",
          },
          message: null,
          facts: {
            os: "Linux",
            arch: "x86_64",
            user: "dev",
            root: false,
            node: null,
            nodeVersion: null,
            npm: false,
            curl: true,
            systemd: true,
            container: false,
            linger: false,
            routes: [],
            installs: [],
          },
        },
        blockers: ["Node.js 22.19 or newer is required on build-box."],
      }),
    );
    await slot.findByText("In bb");
    fireEvent.click(slot.getByRole("button", { name: /build-box/u }));
    fireEvent.click(slot.getByRole("button", { name: "Check connection" }));
    await slot.findByText("Node.js 22.19 or newer is required on build-box.");
    expect(latest()).toEqual({
      status: "blocked",
      reason: "Fix the problems the check found.",
    });
  });
});
