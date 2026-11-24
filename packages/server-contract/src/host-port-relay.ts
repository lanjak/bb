import { z } from "zod";

export const HOST_PORT_RELAY_PATH_PREFIX = "/ws/host-ports/";

export const hostPortRelayRefusalSchema = z.enum([
  "host_not_found",
  "host_offline",
  "invalid_port",
  "machine_credential",
  "relay_limit",
]);
export type HostPortRelayRefusal = z.infer<typeof hostPortRelayRefusalSchema>;

export const HOST_PORT_RELAY_REFUSED_CLOSE_CODE = 1008;

export const HOST_PORT_RELAY_CLOSE_REASONS = [
  ...hostPortRelayRefusalSchema.options,
  "refused",
  "timeout",
  "limit",
  "error",
  "idle",
  "frame_too_large",
] as const;

export const hostPortRelayAccessResponseSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.enum(["machine_credential"]).nullable(),
  })
  .strict();
export type HostPortRelayAccessResponse = z.infer<
  typeof hostPortRelayAccessResponseSchema
>;

export function hostPortRelayPath(hostId: string, port: number): string {
  return `${HOST_PORT_RELAY_PATH_PREFIX}${encodeURIComponent(hostId)}/${port}`;
}

export function hostPortRelayUrl(args: {
  baseUrl: string;
  hostId: string;
  port: number;
}): string {
  const url = new URL(args.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${hostPortRelayPath(
    args.hostId,
    args.port,
  )}`;
  url.search = "";
  url.hash = "";
  return url.href;
}
