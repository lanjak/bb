import { z } from "zod";

const destinationPattern =
  /^(?:[A-Za-z0-9_][A-Za-z0-9._+-]*@)?(?:\[[0-9A-Fa-f:.%A-Za-z]+\]|[A-Za-z0-9_][A-Za-z0-9._-]*|[0-9A-Fa-f]*:[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._-]+)?)$/u;

export const destinationSchema = z
  .string()
  .max(255, "Destination is too long")
  .regex(destinationPattern, "Enter a host alias, host name or user@host");

export const portSchema = z.number().int().min(1).max(65535);

const printablePattern = /^[^\p{Cc}]+$/u;

export const identityFileSchema = z
  .string()
  .max(1024)
  .regex(printablePattern, "Identity file path has control characters")
  .refine(
    (value) => value.startsWith("/") || value.startsWith("~/"),
    "Identity file must be an absolute path or start with ~/",
  );

export const fingerprintSchema = z
  .string()
  .regex(
    /^SHA256:[A-Za-z0-9+/]{43}$/u,
    "Host key must be a SHA256 fingerprint such as SHA256:abc...",
  );

export const sshTargetSchema = z
  .object({
    destination: destinationSchema,
    port: portSchema.nullable(),
    identityFile: identityFileSchema.nullable(),
  })
  .strict();
export type SshTarget = z.infer<typeof sshTargetSchema>;

export const resolvedTargetSchema = z
  .object({
    user: z.string().max(255),
    hostname: z.string().min(1).max(255),
    port: portSchema,
    proxyJump: z.string().max(1024).nullable(),
    knownHostsName: z.string().min(1).max(512),
    strictHostKeyChecking: z.boolean(),
  })
  .strict();
export type ResolvedTarget = z.infer<typeof resolvedTargetSchema>;

export function formatResolved(resolved: ResolvedTarget): string {
  return `${resolved.user}@${resolved.hostname}:${resolved.port}`;
}

export function sameResolvedTarget(
  left: ResolvedTarget,
  right: ResolvedTarget,
): boolean {
  return (
    left.user === right.user &&
    left.hostname === right.hostname &&
    left.port === right.port
  );
}

export const machineInputsSchema = z
  .object({
    via: z.string().min(1).max(128),
    destination: destinationSchema,
    port: portSchema.optional(),
    identityFile: identityFileSchema.optional(),
    name: z.string().trim().min(1).max(64).regex(printablePattern).optional(),
    hostKey: fingerprintSchema.optional(),
    keepRunning: z.boolean().default(true),
    access: z
      .string()
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/u)
      .optional(),
  })
  .strict();
export type MachineInputs = z.infer<typeof machineInputsSchema>;

export function targetFromInputs(inputs: {
  destination: string;
  port?: number | undefined;
  identityFile?: string | undefined;
}): SshTarget {
  return {
    destination: inputs.destination,
    port: inputs.port ?? null,
    identityFile: inputs.identityFile ?? null,
  };
}

export const machineResourceSchema = z
  .object({
    via: z.string().min(1),
    target: sshTargetSchema,
    resolved: resolvedTargetSchema,
    keepRunning: z.boolean(),
    pinnedKey: z.string().max(8192).nullable(),
    enabledLinger: z.boolean(),
    launchKey: z.string().min(1),
  })
  .strict();
export type MachineResource = z.infer<typeof machineResourceSchema>;
