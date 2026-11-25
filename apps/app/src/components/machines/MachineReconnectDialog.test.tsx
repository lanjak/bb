// @vitest-environment jsdom

import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { Dialog, DialogContent } from "@bb/shared-ui/dialog";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MachineReconnectView } from "./MachineReconnectDialog";

afterEach(cleanup);

it("keeps the update title after the machine reconnects", () => {
  const view = (lastRejectedProtocolVersion: number | null) => (
    <Dialog open>
      <DialogContent>
        <MachineReconnectView
          host={makeHost({
            machineProviderId: "ssh",
            lastRejectedProtocolVersion,
          })}
          executorPhrase="over SSH"
          prepared={null}
          errorMessage={null}
          onReconnect={() => {}}
          onDone={() => {}}
        />
      </DialogContent>
    </Dialog>
  );
  const rendered = render(view(1));
  expect(screen.getByRole("dialog", { name: "Update over SSH" })).toBeDefined();
  rendered.rerender(view(null));
  expect(screen.getByRole("dialog", { name: "Update over SSH" })).toBeDefined();
});
