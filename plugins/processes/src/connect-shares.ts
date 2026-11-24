import { z } from "zod";

export const CONNECT_PLUGIN_ID = "connect";
export const CONNECT_SHARES_KEY = "connectShares";
export const SHARE_GONE_MS = 60_000;
export const SHARE_SWEEP_INTERVAL_MS = 15_000;

export const OFF_REASON =
  "Open this from the desktop app or from the machine itself. To reach it from here, run `bb machine forward <port> --machine <machine>` on this computer.";

const createdShareSchema = z
  .object({
    hostId: z.string(),
    port: z.number().int(),
    threadId: z.string(),
    lastSeenAt: z.number(),
  })
  .strict();
export type CreatedShare = z.infer<typeof createdShareSchema>;

const storedSchema = z.array(createdShareSchema);

export const connectStatusSchema = z
  .object({
    enabled: z.boolean(),
    paired: z.boolean(),
    state: z.string(),
  })
  .passthrough();

export const connectShareSchema = z
  .object({ hostId: z.string(), port: z.number().int(), url: z.string() })
  .passthrough();
export type ConnectShare = z.infer<typeof connectShareSchema>;

export type OpenViaConnectResult =
  | { status: "ok"; url: string }
  | { status: "connect-off" | "failed"; reason: string };

export interface ConnectSharesDependencies {
  loadCreated(): Promise<unknown>;
  saveCreated(shares: CreatedShare[]): Promise<void>;
  status(): Promise<z.infer<typeof connectStatusSchema>>;
  listShares(): Promise<ConnectShare[]>;
  expose(args: { hostId: string; port: number }): Promise<ConnectShare>;
  unexpose(args: { hostId: string; port: number }): Promise<void>;
  now(): number;
  warn(message: string): void;
}

export function createConnectShares(deps: ConnectSharesDependencies) {
  let tail: Promise<unknown> = Promise.resolve();

  function inTurn<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  }

  async function created(): Promise<CreatedShare[]> {
    const parsed = storedSchema.safeParse(await deps.loadCreated());
    return parsed.success ? parsed.data : [];
  }

  async function openShare(args: {
    threadId: string;
    hostId: string;
    port: number;
  }): Promise<OpenViaConnectResult> {
    let status: z.infer<typeof connectStatusSchema>;
    try {
      status = connectStatusSchema.parse(await deps.status());
    } catch {
      return { status: "connect-off", reason: OFF_REASON };
    }
    if (!status.enabled || !status.paired || status.state !== "connected")
      return { status: "connect-off", reason: OFF_REASON };
    try {
      const existing = (await deps.listShares()).find(
        (share) => share.hostId === args.hostId && share.port === args.port,
      );
      if (existing !== undefined) return { status: "ok", url: existing.url };
      const share = await deps.expose({
        hostId: args.hostId,
        port: args.port,
      });
      await deps.saveCreated([
        ...(await created()),
        {
          hostId: args.hostId,
          port: args.port,
          threadId: args.threadId,
          lastSeenAt: deps.now(),
        },
      ]);
      return { status: "ok", url: share.url };
    } catch (error) {
      return {
        status: "failed",
        reason: `bb Connect could not share the port: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function sweepThread(args: {
    threadId: string;
    listening: ReadonlyArray<{ hostId: string; port: number }>;
    archived?: boolean;
  }): Promise<void> {
    const shares = await created();
    if (shares.length === 0) return;
    const now = deps.now();
    const keep: CreatedShare[] = [];
    for (const share of shares) {
      if (share.threadId !== args.threadId) {
        keep.push(share);
        continue;
      }
      const listening = args.listening.some(
        (entry) => entry.hostId === share.hostId && entry.port === share.port,
      );
      const expired =
        args.archived === true ||
        (!listening && now - share.lastSeenAt >= SHARE_GONE_MS);
      if (!expired) {
        keep.push(listening ? { ...share, lastSeenAt: now } : share);
        continue;
      }
      try {
        await deps.unexpose({ hostId: share.hostId, port: share.port });
      } catch (error) {
        deps.warn(
          `Could not remove the bb Connect share of ${share.hostId}:${share.port}: ${String(error)}`,
        );
        keep.push(share);
      }
    }
    await deps.saveCreated(keep);
  }

  function open(
    args: Parameters<typeof openShare>[0],
  ): Promise<OpenViaConnectResult> {
    return inTurn(() => openShare(args));
  }

  function sweep(args: Parameters<typeof sweepThread>[0]): Promise<void> {
    return inTurn(() => sweepThread(args));
  }

  async function sweepAll(
    listening: (
      threadId: string,
    ) => Promise<ReadonlyArray<{ hostId: string; port: number }> | null>,
  ): Promise<void> {
    const threadIds = new Set((await created()).map((share) => share.threadId));
    for (const threadId of threadIds) {
      const ports = await listening(threadId);
      if (ports !== null) await sweep({ threadId, listening: ports });
    }
  }

  return { open, sweep, sweepAll, created };
}
