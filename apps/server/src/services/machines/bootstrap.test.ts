import { describe, expect, it, vi } from "vitest";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { MachineEnrollments, EnrollmentBootstrap } from "./enrollments.js";
import { createMachineBootstrapApi } from "./bootstrap.js";

const bootstrap: EnrollmentBootstrap = {
  hostId: "host_1",
  serverUrl: "https://server.example",
  credential: "private-credential",
  expiresAt: Date.now() + 60_000,
};

function harness() {
  const enrollments: MachineEnrollments = {
    assertOwnedHost: vi.fn(),
    clearPending: vi.fn(),
    prepare: vi.fn<MachineEnrollments["prepare"]>(async () => ({
      id: "enrollment",
      hostId: "host_1",
      state: "pending",
      bootstrap,
    })),
    waitForConnection: vi.fn(async () => ({ hostId: "host_1", hostName: "Host 1" })),
  };
  const api = createMachineBootstrapApi(enrollments);
  const exec = vi.fn<MachineExecutor["exec"]>(async () => ({
    exitCode: 0,
  }));
  const report = { step: vi.fn(), log: vi.fn() };
  return { api, enrollments, exec, report };
}

describe("machine bootstrap", () => {
  it("delivers credentials through stdin and forwards streamed executor output", async () => {
    const h = harness();
    h.exec.mockImplementation(async (request) => {
      request.onOutput("installing\nstart");
      request.onOutput("ed\n");
      return {
        exitCode: 0,
      };
    });
    const result = await h.api.bootstrap({
      key: "key",
      executor: { exec: h.exec },
      report: h.report,
      signal: new AbortController().signal,
    });
    const request = vi.mocked(h.exec).mock.calls[0];
    expect(JSON.stringify(request)).toContain(bootstrap.credential);
    expect(JSON.stringify(h.report.step.mock.calls)).not.toContain(
      bootstrap.credential,
    );
    expect(h.report.log.mock.calls).toEqual([["installing\n"], ["started\n"]]);
    expect(h.enrollments.waitForConnection).toHaveBeenCalledOnce();
    expect(result).toEqual({ hostId: "host_1" });
    expect(request[0].command.join(" ")).not.toContain(bootstrap.credential);
  });

  it("includes the last 20 streamed lines when the command exits non-zero", async () => {
    const h = harness();
    h.exec.mockImplementation(async (request) => {
      request.onOutput(
        Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join(
          "\n",
        ) + "\n",
      );
      return { exitCode: 9 };
    });
    const error = await h.api
      .bootstrap({
        key: "key",
        executor: { exec: h.exec },
        report: h.report,
        signal: new AbortController().signal,
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("line 6\nline 7");
    expect(error.message).toContain("line 25");
    expect(error.message).not.toContain("line 5\n");
  });

  it("redacts transport failures and clears pending enrollment", async () => {
    const h = harness();
    h.exec.mockRejectedValue(new Error(bootstrap.credential));
    await expect(
      h.api.bootstrap({
        key: "key",
        executor: { exec: h.exec },
        report: h.report,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/^Machine bootstrap command failed$/);
    expect(h.enrollments.waitForConnection).not.toHaveBeenCalled();
    expect(h.enrollments.clearPending).toHaveBeenCalledWith("key");
  });

  it("starts an already enrolled machine before waiting after snapshot restore", async () => {
    const h = harness();
    vi.mocked(h.enrollments.prepare).mockResolvedValue({
      id: "enrollment",
      hostId: "host_1",
      state: "enrolled",
    });
    await h.api.bootstrap({
      key: "key",
      executor: { exec: h.exec },
      report: h.report,
      signal: new AbortController().signal,
    });
    expect(h.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["sh", "-s", "--", "--start", "--host-id", "host_1"],
        stdin: expect.stringContaining("Usage: install.sh"),
      }),
    );
    expect(h.enrollments.waitForConnection).toHaveBeenCalledOnce();
  });

  it("uninstalls only a machine the plugin owns, through the installer", async () => {
    const h = harness();
    await h.api.uninstall({
      hostId: "host_1",
      executor: { exec: h.exec },
      report: h.report,
      signal: new AbortController().signal,
    });
    expect(h.enrollments.assertOwnedHost).toHaveBeenCalledWith("host_1");
    expect(h.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["sh", "-s", "--", "--uninstall", "--host-id", "host_1"],
        stdin: expect.stringContaining("Usage: install.sh"),
      }),
    );

    vi.mocked(h.enrollments.assertOwnedHost).mockImplementation(() => {
      throw new Error("Machine enrollment was not found");
    });
    await expect(
      h.api.uninstall({
        hostId: "host_2",
        executor: { exec: h.exec },
        report: h.report,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Machine enrollment was not found");
    expect(h.exec).toHaveBeenCalledOnce();
  });

  it("stops waiting for an executor that ignores the abort signal", async () => {
    const h = harness();
    const controller = new AbortController();
    h.exec.mockImplementation(() => new Promise<never>(() => {}));
    const pending = h.api.uninstall({
      hostId: "host_1",
      executor: { exec: h.exec },
      report: h.report,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(h.exec).toHaveBeenCalledOnce());
    controller.abort(new Error("removal cancelled"));
    await expect(pending).rejects.toThrow("removal cancelled");
  });

  it("does no work after abort", async () => {
    const h = harness();
    await expect(
      h.api.bootstrap({
        key: "key",
        executor: { exec: h.exec },
        report: h.report,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(h.enrollments.prepare).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
  });
});

it("cancels pending preparation without executing or waiting for enrollment", async () => {
  const h = harness();
  const controller = new AbortController();
  vi.mocked(h.enrollments.prepare).mockImplementation(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const pending = h.api.bootstrap({
    key: "pending",
    executor: { exec: h.exec },
    report: h.report,
    signal: controller.signal,
  });
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(h.exec).not.toHaveBeenCalled();
  expect(h.enrollments.waitForConnection).not.toHaveBeenCalled();
  expect(h.enrollments.clearPending).toHaveBeenCalledWith("pending");
});
