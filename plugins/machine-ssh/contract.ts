import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  fingerprintSchema,
  resolvedTargetSchema,
  sshTargetSchema,
} from "./target.js";

export const MAX_CONFIG_HOSTS = 200;
export const MAX_ROUTE_URLS = 16;
export const MAX_COMMAND_ARGS = 64;
export const OUTPUT_CHUNK_MAX_CHARS = 16_384;

export const configHostSchema = z
  .object({ alias: z.string().min(1).max(255) })
  .strict();

export const remoteFactsSchema = z
  .object({
    os: z.string().max(512),
    arch: z.string().max(512),
    user: z.string().max(512),
    root: z.boolean(),
    node: z.string().max(512).nullable(),
    nodeVersion: z.string().max(512).nullable(),
    npm: z.boolean(),
    curl: z.boolean(),
    systemd: z.boolean(),
    container: z.boolean(),
    linger: z.boolean().nullable(),
    routes: z
      .array(
        z
          .object({ url: z.string().max(2048), status: z.number().int() })
          .strict(),
      )
      .max(MAX_ROUTE_URLS),
    installs: z
      .array(
        z
          .object({
            hostId: z.string().max(128),
            serverUrl: z.string().max(2048),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type RemoteFacts = z.infer<typeof remoteFactsSchema>;

export const inspectionSchema = z
  .object({
    resolved: resolvedTargetSchema,
    hostKey: z
      .object({
        state: z.enum(["trusted", "unknown", "changed", "unreachable"]),
        fingerprint: fingerprintSchema.nullable(),
        keyType: z.string().max(64).nullable(),
      })
      .strict(),
    message: z.string().max(4000).nullable(),
    facts: remoteFactsSchema.nullable(),
  })
  .strict();
export type Inspection = z.infer<typeof inspectionSchema>;

export const sshHostContract = defineRpcContract({
  listConfigHosts: {
    input: z.object({}).strict(),
    output: z
      .object({
        configPath: z.string(),
        hosts: z.array(configHostSchema).max(MAX_CONFIG_HOSTS),
        truncated: z.boolean(),
      })
      .strict(),
    experimental_retryable: true,
  },
  resolve: {
    input: z.object({ target: sshTargetSchema }).strict(),
    output: z
      .object({ resolved: resolvedTargetSchema, knownHost: z.boolean() })
      .strict(),
    experimental_retryable: true,
  },
  inspect: {
    input: z
      .object({
        target: sshTargetSchema,
        routeUrls: z.array(z.string().url().max(2048)).max(MAX_ROUTE_URLS),
      })
      .strict(),
    output: inspectionSchema,
    experimental_retryable: true,
  },
  trust: {
    input: z
      .object({ target: sshTargetSchema, fingerprint: fingerprintSchema })
      .strict(),
    output: z.object({ pinnedKey: z.string().max(8192).nullable() }).strict(),
  },
  forget: {
    input: z.object({ pinnedKey: z.string().min(1).max(8192) }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  exec: {
    input: z
      .object({
        executionId: z.string().min(1).max(128),
        target: sshTargetSchema,
        command: z.array(z.string()).min(1).max(MAX_COMMAND_ARGS),
        stdin: z.string(),
        timeoutMs: z.number().int().positive(),
        linger: z.boolean(),
      })
      .strict(),
    output: z.object({ exitCode: z.number().int() }).strict(),
  },
});

export const sshHostSignals = {
  output: {
    payload: z
      .object({
        executionId: z.string().min(1).max(128),
        chunk: z.string().max(OUTPUT_CHUNK_MAX_CHARS),
      })
      .strict(),
  },
} as const;
