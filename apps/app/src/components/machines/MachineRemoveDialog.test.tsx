// @vitest-environment jsdom

import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { appToast } from "@/components/ui/app-toast";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { MachineRemoveDialog } from "./MachineRemoveDialog";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: {
      delete: async () => ({
        ok: true,
        progress: "complete",
        warnings: ["The daemon may still run on the computer."],
      }),
    },
  },
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useMachineThreadPreview: () => ({ data: undefined }),
}));

afterEach(cleanup);

it("keeps what the removal left behind on screen after the dialog closes", async () => {
  const warning = vi.spyOn(appToast, "warning").mockReturnValue(1);
  const onOpenChange = vi.fn();
  const { wrapper } = createQueryClientTestHarness();
  render(
    <MachineRemoveDialog
      target={makeHost({ name: "Build box", machineProviderId: "ssh" })}
      onOpenChange={onOpenChange}
    />,
    { wrapper },
  );

  fireEvent.click(screen.getByRole("button", { name: "Remove machine" }));

  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(warning).toHaveBeenCalledWith("Build box was removed", {
    description: "The daemon may still run on the computer.",
    duration: Number.POSITIVE_INFINITY,
  });
});
