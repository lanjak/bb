import type { EventSource, HookVerification } from "../rpc-types.js";

export interface AdapterRequest {
  headers: Headers;
  rawBody: Buffer;
  secret: string;
  verification: HookVerification;
  nowMs: number;
}

export type AdapterVerdict =
  | { ok: true; deliveryKey: string | null; event: string | null }
  | { ok: false; status: 401 | 400; error: string };

export interface EventAdapter {
  source: EventSource;
  verify(request: AdapterRequest): AdapterVerdict;
  deriveKind(args: { event: string | null; payload: unknown }): string;
  isPing(args: { event: string | null }): boolean;
  matchView(args: { payload: unknown; kind: string }): unknown;
}
