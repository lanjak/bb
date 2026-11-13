import { z } from "zod";

export const THREAD_TRANSFER_CHUNK_MAX_BYTES = 1024 * 1024;
export const THREAD_TRANSFER_MAX_FILES = 10_000;

const transferIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const threadTransferRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      (value.startsWith("session/") || value.startsWith("storage/")) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Transfer paths start with session/ or storage/ and stay inside them",
  );

export const threadTransferFileSchema = z
  .object({
    relativePath: threadTransferRelativePathSchema,
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
    mode: z.number().int().min(0).max(0o777),
  })
  .strict();
export type ThreadTransferFile = z.infer<typeof threadTransferFileSchema>;

export const threadTransferManifestSchema = z
  .array(threadTransferFileSchema)
  .max(THREAD_TRANSFER_MAX_FILES);

const threadTransferSessionSchema = z
  .object({
    threadId: z.string().min(1),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
    cwd: z.string().min(1),
  })
  .strict();

export const threadTransferExportCommandSchema = threadTransferSessionSchema
  .extend({
    type: z.literal("thread.transfer.export"),
    transferId: transferIdSchema,
  })
  .strict();

export const threadTransferExportResultSchema = z
  .object({ files: threadTransferManifestSchema })
  .strict();

export const threadTransferReadChunkCommandSchema = z
  .object({
    type: z.literal("thread.transfer.read_chunk"),
    transferId: transferIdSchema,
    relativePath: threadTransferRelativePathSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    length: z.number().int().positive().max(THREAD_TRANSFER_CHUNK_MAX_BYTES),
  })
  .strict();

export const threadTransferReadChunkResultSchema = z
  .object({
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentBase64: z
      .string()
      .max(4 * Math.ceil(THREAD_TRANSFER_CHUNK_MAX_BYTES / 3)),
  })
  .strict();

export const threadTransferWriteChunkCommandSchema = z
  .object({
    type: z.literal("thread.transfer.write_chunk"),
    transferId: transferIdSchema,
    relativePath: threadTransferRelativePathSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentBase64: z
      .string()
      .max(4 * Math.ceil(THREAD_TRANSFER_CHUNK_MAX_BYTES / 3)),
  })
  .strict();

export const threadTransferWriteChunkResultSchema = z
  .object({
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const threadTransferCommitCommandSchema = threadTransferSessionSchema
  .extend({
    type: z.literal("thread.transfer.commit"),
    transferId: transferIdSchema,
    files: threadTransferManifestSchema,
  })
  .strict();

export const threadTransferCommitResultSchema = z
  .object({
    placedFiles: z.number().int().nonnegative(),
    backedUpFiles: z.number().int().nonnegative(),
  })
  .strict();

export const threadTransferRollbackCommandSchema = z
  .object({
    type: z.literal("thread.transfer.rollback"),
    transferId: transferIdSchema,
  })
  .strict();

export const threadTransferFinishCommandSchema = z
  .object({
    type: z.literal("thread.transfer.finish"),
    transferId: transferIdSchema,
    setAsideSession: threadTransferSessionSchema.nullable(),
  })
  .strict();

export const threadTransferDoneResultSchema = z
  .object({ ok: z.literal(true) })
  .strict();
