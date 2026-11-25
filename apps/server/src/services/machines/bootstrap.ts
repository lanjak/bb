import type { MachineBootstrapApi } from "@get-bb/plugin-sdk";
import type { MachineEnrollments } from "./enrollments.js";
import {
  enrollmentInstallerExecution,
  INSTALLER_TIMEOUT_MS,
  installerLifecycleExecution,
  runInstallerExecution,
} from "./installer-runner.js";

export function createMachineBootstrapApi(
  enrollments: MachineEnrollments,
): MachineBootstrapApi {
  return {
    async bootstrap(request) {
      request.signal.throwIfAborted();
      request.report.step("Preparing machine enrollment");
      try {
        const enrollment = await enrollments.prepare({
          key: request.key,
          signal: request.signal,
          ...(request.access === undefined ? {} : { access: request.access }),
        });
        request.signal.throwIfAborted();
        request.report.step(
          enrollment.state === "enrolled"
            ? "Starting enrolled machine"
            : "Bootstrapping machine",
        );
        const execution = await (enrollment.state === "enrolled"
          ? installerLifecycleExecution("start", enrollment.hostId)
          : enrollmentInstallerExecution(enrollment.bootstrap));
        await runInstallerExecution({
          executor: request.executor,
          execution,
          report: request.report,
          signal: request.signal,
          timeoutMs: INSTALLER_TIMEOUT_MS,
          failure: "Machine bootstrap command failed",
        });
        request.signal.throwIfAborted();
        request.report.step("Waiting for machine connection");
        await enrollments.waitForConnection({
          enrollmentId: enrollment.id,
          timeoutMs: 120_000,
          signal: request.signal,
        });
        return { hostId: enrollment.hostId };
      } catch (error) {
        enrollments.clearPending(request.key);
        throw error;
      }
    },
    async uninstall(request) {
      request.signal.throwIfAborted();
      enrollments.assertOwnedHost(request.hostId);
      request.report.step("Uninstalling the machine service");
      await runInstallerExecution({
        executor: request.executor,
        execution: await installerLifecycleExecution(
          "uninstall",
          request.hostId,
        ),
        report: request.report,
        signal: request.signal,
        timeoutMs: INSTALLER_TIMEOUT_MS,
        failure: "Machine uninstall command failed",
      });
    },
  };
}
