import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { configHostSchema, inspectionSchema } from "./contract.js";
import { machineInputsSchema } from "./target.js";

export const checkReportSchema = z
  .object({
    inspection: inspectionSchema,
    blockers: z.array(z.string()),
    notes: z.array(z.string()),
    machineName: z.string().nullable(),
  })
  .strict();
export type CheckReport = z.infer<typeof checkReportSchema>;

export const listedConfigHostSchema = configHostSchema.extend({
  machineName: z.string().nullable(),
});
export type ListedConfigHost = z.infer<typeof listedConfigHostSchema>;

export const connectionOptionsSchema = z
  .object({
    machines: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          connected: z.boolean(),
          server: z.boolean(),
        })
        .strict(),
    ),
    routes: z.array(
      z.object({ id: z.string(), displayName: z.string() }).strict(),
    ),
  })
  .strict();
export type ConnectionOptions = z.infer<typeof connectionOptionsSchema>;

export const checkRequestSchema = machineInputsSchema.pick({
  via: true,
  destination: true,
  port: true,
  identityFile: true,
  access: true,
  keepRunning: true,
});
export type CheckRequest = z.input<typeof checkRequestSchema>;

export const sshAppContract = defineRpcContract({
  connectionOptions: {
    input: z.object({}).strict(),
    output: connectionOptionsSchema,
  },
  configHosts: {
    input: z.object({ via: z.string().min(1) }).strict(),
    output: z
      .object({
        configPath: z.string(),
        hosts: z.array(listedConfigHostSchema),
        truncated: z.boolean(),
      })
      .strict(),
  },
  check: {
    input: checkRequestSchema,
    output: checkReportSchema,
  },
});
