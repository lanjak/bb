import { z } from "zod";

export const HOST_PORT_RELAY_FRAME_MAX_BYTES = 64 * 1024;
export const HOST_PORT_RELAY_TOKEN_HEADER = "x-bb-relay-token";
export const HOST_PORT_RELAY_DAEMON_PATH_PREFIX = "/internal/host-ports/";

export function hostPortRelayDaemonPath(relayId: string): string {
  return `${HOST_PORT_RELAY_DAEMON_PATH_PREFIX}${encodeURIComponent(relayId)}`;
}

export const hostPortRelayIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const hostPortRelayPortSchema = z.number().int().min(1).max(65535);

export const hostPortRelayTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const hostPortConnectMessageSchema = z
  .object({
    type: z.literal("host-port.connect"),
    relayId: hostPortRelayIdSchema,
    port: hostPortRelayPortSchema,
    token: hostPortRelayTokenSchema,
  })
  .strict();
export type HostPortConnectMessage = z.infer<
  typeof hostPortConnectMessageSchema
>;

export const hostPortConnectFailureCodeSchema = z.enum([
  "refused",
  "timeout",
  "limit",
  "error",
]);
export type HostPortConnectFailureCode = z.infer<
  typeof hostPortConnectFailureCodeSchema
>;

export const hostPortConnectFailedMessageSchema = z
  .object({
    type: z.literal("host-port.connect-failed"),
    relayId: hostPortRelayIdSchema,
    code: hostPortConnectFailureCodeSchema,
    message: z.string().max(200),
  })
  .strict();
export type HostPortConnectFailedMessage = z.infer<
  typeof hostPortConnectFailedMessageSchema
>;
