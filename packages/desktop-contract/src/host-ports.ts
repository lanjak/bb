import { z } from "zod";

export const bbDesktopHostPortEnsureRequestSchema = z
  .object({
    hostId: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    relayUrl: z.string().min(1),
    preferredLocalPort: z.number().int().min(1).max(65535).optional(),
  })
  .strict();
export type BbDesktopHostPortEnsureRequest = z.infer<
  typeof bbDesktopHostPortEnsureRequestSchema
>;

export const bbDesktopHostPortStopRequestSchema = z
  .object({
    hostId: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
export type BbDesktopHostPortStopRequest = z.infer<
  typeof bbDesktopHostPortStopRequestSchema
>;

export const bbDesktopHostPortForwardSchema = z
  .object({
    hostId: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    localPort: z.number().int().min(1).max(65535),
    connections: z.number().int().nonnegative(),
    serverOrigin: z.string(),
  })
  .strict();
export type BbDesktopHostPortForward = z.infer<
  typeof bbDesktopHostPortForwardSchema
>;

export const bbDesktopHostPortForwardListSchema = z.array(
  bbDesktopHostPortForwardSchema,
);

export interface BbDesktopHostPortsApi {
  ensure(
    request: BbDesktopHostPortEnsureRequest,
  ): Promise<BbDesktopHostPortForward>;
  stop(request: BbDesktopHostPortStopRequest): Promise<void>;
  list(): Promise<BbDesktopHostPortForward[]>;
  onChange(
    listener: (forwards: BbDesktopHostPortForward[]) => void,
  ): () => void;
}
