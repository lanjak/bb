import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_MACHINE_PATHS } from "./src/paths.js";

export const serverPortSchema = z
  .object({ port: z.number().int(), address: z.string() })
  .strict();
export type ServerPort = z.infer<typeof serverPortSchema>;

export const devServerSchema = z
  .object({
    threadId: z.string(),
    rootPid: z.number().int(),
    startToken: z.string(),
    startedAt: z.number().nullable(),
    command: z.string().nullable(),
    cwd: z.string().nullable(),
    ports: z.array(serverPortSchema).min(1),
  })
  .strict();
export type DevServer = z.infer<typeof devServerSchema>;

export const processRoleSchema = z.enum(["agent", "command", "server"]);
export type ProcessRole = z.infer<typeof processRoleSchema>;

export const stopOutcomeSchema = z.enum([
  "stopped",
  "not-found",
  "not-stoppable",
  "changed",
  "still-running",
]);
export type StopOutcome = z.infer<typeof stopOutcomeSchema>;

const capabilitySchema = z
  .object({ supported: z.boolean(), reason: z.string().nullable() })
  .strict();

const memoryPressureSchema = z.enum(["normal", "warn", "critical"]);

export const machineSampleSchema = z
  .object({
    platform: z.string(),
    cpuPercent: z.number().nullable(),
    cpuCount: z.number().int(),
    loadAverage: z.array(z.number()).nullable(),
    memory: z
      .object({
        totalBytes: z.number(),
        usedBytes: z.number(),
        source: z.enum(["meminfo", "cgroup", "vm_stat", "os"]),
        pressure: memoryPressureSchema.nullable(),
      })
      .strict(),
    disks: z.array(
      z
        .object({
          label: z.string(),
          path: z.string(),
          device: z.string(),
          totalBytes: z.number(),
          freeBytes: z.number(),
        })
        .strict(),
    ),
    sampledAt: z.number(),
  })
  .strict();
export type MachineSampleResult = z.infer<typeof machineSampleSchema>;

export const sampledProcessSchema = z
  .object({
    pid: z.number().int(),
    ppid: z.number().int(),
    name: z.string(),
    command: z.string().nullable(),
    cpuPercent: z.number().nullable(),
    rssBytes: z.number(),
    startToken: z.string(),
    startedAt: z.number().nullable(),
    threadId: z.string(),
    role: processRoleSchema,
    rootPid: z.number().int().nullable(),
    ports: z.array(serverPortSchema),
  })
  .strict();
export type SampledProcess = z.infer<typeof sampledProcessSchema>;

export const otherProcessSchema = z
  .object({
    pid: z.number().int(),
    name: z.string(),
    cpuPercent: z.number().nullable(),
    rssBytes: z.number(),
    startToken: z.string(),
  })
  .strict();
export type SampledOtherProcess = z.infer<typeof otherProcessSchema>;

export const processesSampleSchema = z
  .object({
    threads: capabilitySchema,
    processes: z.array(sampledProcessSchema),
    others: z.array(otherProcessSchema),
    sampledAt: z.number(),
  })
  .strict();
export type ProcessesSample = z.infer<typeof processesSampleSchema>;

const stopInputSchema = z
  .object({
    threadId: z.string().min(1),
    rootPid: z.number().int().positive(),
    startToken: z.string().min(1),
  })
  .strict();

export const processesHostContract = defineRpcContract({
  list: {
    experimental_retryable: true,
    input: z.object({ threadId: z.string().min(1).nullable() }).strict(),
    output: z
      .object({
        supported: z.boolean(),
        reason: z.string().nullable(),
        servers: z.array(devServerSchema),
      })
      .strict(),
  },
  "machine.sample": {
    input: z
      .object({ paths: z.array(z.string()).max(MAX_MACHINE_PATHS) })
      .strict(),
    output: machineSampleSchema,
  },
  "processes.sample": {
    input: z
      .object({ includeOthers: z.number().int().min(0).max(50) })
      .strict(),
    output: processesSampleSchema,
  },
  "processes.stop": {
    input: stopInputSchema,
    output: z.object({ outcome: stopOutcomeSchema }).strict(),
  },
});

export function serversTag(threadId: string): string {
  return `servers:${threadId}`;
}

export function threadUsageTag(threadId: string): string {
  return `usage:thread:${threadId}`;
}

export function machineUsageTag(hostId: string): string {
  return `usage:machine:${hostId}`;
}

export const MACHINES_USAGE_TAG = "usage:machines";

const hostServerSchema = devServerSchema.extend({
  hostId: z.string(),
  hostName: z.string(),
});
export type HostDevServer = z.infer<typeof hostServerSchema>;

const usageStatusSchema = z.enum(["ok", "warning", "critical"]);
export type UsageStatus = z.infer<typeof usageStatusSchema>;

const diskViewSchema = z
  .object({
    label: z.string(),
    path: z.string(),
    totalBytes: z.number(),
    freeBytes: z.number(),
    freePercent: z.number(),
    status: usageStatusSchema,
  })
  .strict();

export const machineViewSchema = z
  .object({
    hostId: z.string(),
    name: z.string(),
    online: z.boolean(),
    status: usageStatusSchema,
    reasons: z.array(z.string()),
    platform: z.string().nullable(),
    cpuPercent: z.number().nullable(),
    cpuCount: z.number().int().nullable(),
    loadAverage: z.array(z.number()).nullable(),
    memory: z
      .object({
        totalBytes: z.number(),
        usedBytes: z.number(),
        percent: z.number(),
        status: usageStatusSchema,
        source: z.enum(["meminfo", "cgroup", "vm_stat", "os"]),
        pressure: memoryPressureSchema.nullable(),
      })
      .strict()
      .nullable(),
    cpuSaturated: z.boolean(),
    cpuStatus: usageStatusSchema,
    disks: z.array(diskViewSchema),
    sampledAt: z.number().nullable(),
  })
  .strict();
export type MachineView = z.infer<typeof machineViewSchema>;

export const processRowSchema = z
  .object({
    pid: z.number().int(),
    ppid: z.number().int(),
    name: z.string(),
    command: z.string().nullable(),
    cpuPercent: z.number().nullable(),
    rssBytes: z.number(),
    startToken: z.string(),
    startedAt: z.number().nullable(),
    role: processRoleSchema,
    rootPid: z.number().int().nullable(),
    stoppable: z.boolean(),
    ports: z.array(serverPortSchema),
  })
  .strict();
export type ProcessRow = z.infer<typeof processRowSchema>;

export const threadUsageSchema = z
  .object({
    threadId: z.string(),
    title: z.string(),
    cpuPercent: z.number(),
    rssBytes: z.number(),
    processCount: z.number().int(),
    processes: z.array(processRowSchema),
  })
  .strict();
export type ThreadUsage = z.infer<typeof threadUsageSchema>;

const unlinkedUsageSchema = z
  .object({
    cpuPercent: z.number(),
    rssBytes: z.number(),
    processCount: z.number().int(),
    processes: z.array(processRowSchema),
  })
  .strict();

export const machineUsageSchema = z
  .object({
    machine: machineViewSchema,
    threadsSupported: z.boolean(),
    threadsReason: z.string().nullable(),
    threads: z.array(threadUsageSchema),
    otherBb: unlinkedUsageSchema,
    others: z.array(otherProcessSchema),
  })
  .strict();
export type MachineUsage = z.infer<typeof machineUsageSchema>;

export const threadUsageStatusSchema = z.enum([
  "ok",
  "error",
  "no-environment",
  "offline",
  "unsupported",
]);

export const processesContract = defineRpcContract({
  "servers.list": {
    tags: ({ threadId }) => [serversTag(threadId)],
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        status: z.enum(["ok", "no-environment", "offline", "unsupported"]),
        reason: z.string().nullable(),
        servers: z.array(hostServerSchema),
      })
      .strict(),
  },
  "servers.open": {
    input: z
      .object({
        threadId: z.string().min(1),
        hostId: z.string().min(1),
        port: z.number().int().min(1).max(65535),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), url: z.string() }).strict(),
      z
        .object({
          status: z.enum(["connect-off", "failed"]),
          reason: z.string(),
        })
        .strict(),
    ]),
  },
  "processes.stop": {
    input: stopInputSchema,
    output: z.object({ outcome: stopOutcomeSchema }).strict(),
  },
  "resources.machines": {
    tags: () => [MACHINES_USAGE_TAG],
    input: z.object({}).strict(),
    output: z
      .object({ machines: z.array(machineViewSchema), toasts: z.boolean() })
      .strict(),
  },
  "resources.machine": {
    tags: ({ hostId }) => [machineUsageTag(hostId)],
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: machineUsageSchema,
  },
  "resources.thread": {
    tags: ({ threadId }) => [threadUsageTag(threadId)],
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        status: threadUsageStatusSchema,
        reason: z.string().nullable(),
        hostId: z.string().nullable(),
        hostName: z.string().nullable(),
        usage: threadUsageSchema.nullable(),
      })
      .strict(),
  },
});
