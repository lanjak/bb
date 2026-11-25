import type {
  JsonValue,
  PluginMachineValidateDecision,
  StandardSchemaV1,
  StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk";
import type { MachineExecutor } from "./machine-bootstrap.js";

export type PluginMachineProviderResource = Exclude<JsonValue, null>;

export type PluginMachineProviderInputsSchema = StandardSchemaV1 | undefined;
type InputsValue<S> = S extends StandardSchemaV1
  ? StandardSchemaV1InferOutput<S>
  : null;
export interface PluginMachineProviderProgress {
  step(text: string): void;
  log(text: string): void;
}

export type PluginMachineProviderAvailability =
  | { status: "available" }
  | { status: "setup-required"; message: string }
  | { status: "unavailable"; message: string };

export type PluginMachineProviderValidateContext<
  S extends PluginMachineProviderInputsSchema =
    PluginMachineProviderInputsSchema,
> = {
  inputs: InputsValue<S>;
  /**
   * The agent thread that asked for this machine, from the `bb` CLI or a thread
   * spawn, and null otherwise. It identifies well-behaved agents; it is not an
   * authorization boundary.
   */
  requestedByThreadId: string | null;
};

export interface PluginMachineProviderLifecycleContext {
  checkpoint(resource: PluginMachineProviderResource): Promise<void>;
  report: PluginMachineProviderProgress;
  signal: AbortSignal;
}

export type PluginMachineProviderCreateContext<
  S extends PluginMachineProviderInputsSchema =
    PluginMachineProviderInputsSchema,
> = Pick<PluginMachineProviderValidateContext<S>, "inputs"> &
  PluginMachineProviderLifecycleContext & {
    key: string;
    attempt: number;
  };

export type PluginMachineProviderCreateResult =
  | { status: "created"; name: string; resource: PluginMachineProviderResource }
  | { status: "failed"; message: string };

type PluginMachineProviderResourceLifecycleContext =
  PluginMachineProviderLifecycleContext & {
    hostId: string;
    resource: PluginMachineProviderResource;
  };

type PluginMachineProviderRemoveContext = Omit<
  PluginMachineProviderResourceLifecycleContext,
  "checkpoint"
>;

export interface PluginMachineProviderExecutorContext {
  hostId: string;
  resource: PluginMachineProviderResource;
  signal: AbortSignal;
}

export interface PluginMachineProviderResourceResult {
  resource: PluginMachineProviderResource;
}

export type PluginMachineProviderRemoveResult =
  | {
      status: "removed";
      /** What the user must still do by hand. bb returns it with the removal result. */
      warning?: string;
    }
  | { status: "failed"; message: string };

export interface PluginMachineProviderDefinition<
  S extends PluginMachineProviderInputsSchema =
    PluginMachineProviderInputsSchema,
> {
  id: string;
  displayName: string;
  /** One line telling a user what choosing this provider gets them, shown wherever a machine is added. */
  description: string;
  /** Provider glyph, declared icon, or plugin-relative icon path. */
  icon: string;
  ephemeral?: boolean;
  /** Persisted and readable by every plugin. Store secret references, never secrets. */
  inputs?: S;
  availability?():
    | PluginMachineProviderAvailability
    | Promise<PluginMachineProviderAvailability>;
  validate?(
    context: PluginMachineProviderValidateContext<S>,
  ): PluginMachineValidateDecision | Promise<PluginMachineValidateDecision>;
  create(
    context: PluginMachineProviderCreateContext<S>,
  ): Promise<PluginMachineProviderCreateResult>;
  /** Reconcile and remove an uncertain allocation by durable key without creating or bootstrapping. Return failed while allocation intent remains unresolved. */
  reconcileCleanup(context: {
    key: string;
    report: PluginMachineProviderProgress;
    signal: AbortSignal;
  }): Promise<PluginMachineProviderRemoveResult>;
  /** Idempotent: preserve saved state when compute is already stopped; save and stop any remaining compute, including during reconciliation of a suspended machine. */
  suspend?(
    context: PluginMachineProviderResourceLifecycleContext,
  ): Promise<PluginMachineProviderResourceResult>;
  /** Idempotent: reuse existing running compute instead of allocating a duplicate. */
  resume?(
    context: PluginMachineProviderResourceLifecycleContext,
  ): Promise<PluginMachineProviderResourceResult>;
  remove(
    context: PluginMachineProviderRemoveContext,
  ): Promise<PluginMachineProviderRemoveResult>;
  /**
   * Reach the computer behind a machine so bb can run its installer there.
   * With it, core Reconnect reinstalls or updates the daemon through the
   * executor instead of printing a command. Throw with a message the user can
   * act on when the computer cannot be reached; bb then offers the command.
   * Apps describe providers that declare it as "Over <displayName>".
   */
  executor?(
    context: PluginMachineProviderExecutorContext,
  ): MachineExecutor | Promise<MachineExecutor>;
}
