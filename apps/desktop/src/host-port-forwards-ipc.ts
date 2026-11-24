import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
  bbDesktopHostPortEnsureRequestSchema,
  bbDesktopHostPortStopRequestSchema,
  type BbDesktopHostPortForward,
} from "@bb/desktop-contract";
import {
  HOST_PORT_FORWARDS_CHANGED_CHANNEL,
  HOST_PORT_FORWARDS_ENSURE_CHANNEL,
  HOST_PORT_FORWARDS_LIST_CHANNEL,
  HOST_PORT_FORWARDS_STOP_CHANNEL,
} from "./host-port-forward-channels.js";
import {
  HostPortForwardManager,
  HostPortRequestError,
  type HostPortForwardManagerOptions,
} from "./host-port-forwards.js";

export interface HostPortForwardIpcOptions {
  ipcMain: Pick<IpcMain, "handle">;
  isApplicationSender(webContents: WebContents): boolean;
  applicationWebContents(): Iterable<WebContents>;
  readCookieHeader(origin: string): Promise<string | null>;
  forward?: HostPortForwardManagerOptions["forward"];
}

function forwardsOf(
  origin: string | null,
  forwards: readonly BbDesktopHostPortForward[],
): BbDesktopHostPortForward[] {
  return forwards.filter((forward) => forward.serverOrigin === origin);
}

function windowOrigin(contents: WebContents): string | null {
  const url = contents.getURL();
  return URL.canParse(url) ? new URL(url).origin : null;
}

function senderOrigin(event: IpcMainInvokeEvent): string {
  if (
    !hostPortSenderAllowed(event) ||
    event.senderFrame === null ||
    event.senderFrame === undefined
  )
    throw new HostPortRequestError("Application window is unavailable.");
  return new URL(event.senderFrame.url).origin;
}

function hostPortSenderAllowed(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame === event.sender.mainFrame;
}

export function registerHostPortForwardIpc(
  options: HostPortForwardIpcOptions,
): HostPortForwardManager {
  const manager = new HostPortForwardManager({
    readCookieHeader: options.readCookieHeader,
    forward: options.forward,
    onChange: (forwards: BbDesktopHostPortForward[]) => {
      for (const contents of options.applicationWebContents())
        if (!contents.isDestroyed())
          contents.send(
            HOST_PORT_FORWARDS_CHANGED_CHANNEL,
            forwardsOf(windowOrigin(contents), forwards),
          );
    },
  });
  const assertApplication = (event: IpcMainInvokeEvent): string => {
    if (!options.isApplicationSender(event.sender))
      throw new HostPortRequestError("Application window is unavailable.");
    return senderOrigin(event);
  };
  options.ipcMain.handle(
    HOST_PORT_FORWARDS_ENSURE_CHANNEL,
    (event, payload: unknown) =>
      manager.ensure(
        bbDesktopHostPortEnsureRequestSchema.parse(payload),
        assertApplication(event),
      ),
  );
  options.ipcMain.handle(
    HOST_PORT_FORWARDS_STOP_CHANNEL,
    (event, payload: unknown) => {
      const origin = assertApplication(event);
      const request = bbDesktopHostPortStopRequestSchema.parse(payload);
      return manager.stop({ ...request, senderOrigin: origin });
    },
  );
  options.ipcMain.handle(HOST_PORT_FORWARDS_LIST_CHANNEL, (event) =>
    forwardsOf(assertApplication(event), manager.list()),
  );
  return manager;
}
