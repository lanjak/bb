export class ManagedRootAdmissionUnavailableError extends Error {
  constructor(effect: string) {
    super(`Managed root admission is unavailable for ${effect}: cohort NOT_ESTABLISHED`);
  }
}

export interface ManagedRootRegistration {
  readonly cohort: "NOT_ESTABLISHED";
  revoke(): void;
}

export interface ManagedRootEffect {
  assertOriginalAtDequeue(): void;
  runOriginal<T>(body: () => Promise<T>): Promise<T>;
  reserveOriginalCleanup<T>(cleanup: () => Promise<T>): () => Promise<T>;
  complete(): { status: "RELEASED" | "PINNED"; failures: readonly unknown[] };
}

const registrations = new Map<object, ManagedRootRegistration>();
const retainedEffects = new Set<object>();
let epoch = 0;

export function internal_DO_NOT_USE_enrollManagedRoot(originalRoot: object): ManagedRootRegistration {
  const existing = registrations.get(originalRoot);
  if (existing !== undefined) return existing;
  epoch += 1;
  const registration: ManagedRootRegistration = Object.freeze({
    cohort: "NOT_ESTABLISHED",
    revoke() { epoch += 1; },
  });
  registrations.set(originalRoot, registration);
  return registration;
}

export function internal_DO_NOT_USE_assertManagedRootAdmission(effect: string): void {
  if (registrations.size !== 0) throw new ManagedRootAdmissionUnavailableError(effect);
}

export function internal_DO_NOT_USE_beginManagedRootEffect(effect: string): ManagedRootEffect {
  internal_DO_NOT_USE_assertManagedRootAdmission(effect);
  const originalEpoch = epoch;
  const originals = new Map<Promise<unknown>, { settled: boolean; failed: boolean; reason: unknown }>();
  const cleanups = new Set<object>();
  const failures: unknown[] = [];
  let bodyClosed = false;
  let uncertain = false;
  let invoking = 0;
  const owner = { originals, cleanups, failures };
  retainedEffects.add(owner);
  const assertOriginalAtDequeue = () => {
    if (bodyClosed || uncertain || epoch !== originalEpoch) throw new ManagedRootAdmissionUnavailableError(effect);
    internal_DO_NOT_USE_assertManagedRootAdmission(effect);
  };
  const observe = <T>(original: Promise<T>): Promise<T> => {
    if (!originals.has(original)) {
      const record: { settled: boolean; failed: boolean; reason: unknown } = { settled: false, failed: false, reason: undefined };
      originals.set(original, record);
      void original.then(
        () => { record.settled = true; },
        (reason: unknown) => {
          record.settled = true;
          record.failed = true;
          record.reason = reason;
          failures.push(reason);
        },
      );
    }
    return original;
  };
  const invoke = <T>(body: () => Promise<T>): Promise<T> => {
    invoking += 1;
    try { return observe(body()); } catch (reason) {
      return observe(Promise.reject(reason));
    } finally {
      invoking -= 1;
    }
  };
  return Object.freeze({
    assertOriginalAtDequeue,
    runOriginal<T>(body: () => Promise<T>): Promise<T> {
      assertOriginalAtDequeue();
      return invoke(body);
    },
    reserveOriginalCleanup<T>(cleanup: () => Promise<T>): () => Promise<T> {
      assertOriginalAtDequeue();
      const reservation = { cleanup };
      cleanups.add(reservation);
      let original: Promise<T> | undefined;
      let running = false;
      return () => {
        if (original !== undefined) return original;
        if (running) {
          uncertain = true;
          const failure = new ManagedRootAdmissionUnavailableError(effect);
          failures.push(failure);
          throw failure;
        }
        running = true;
        try {
          original = invoke(reservation.cleanup);
          cleanups.delete(reservation);
          return original;
        } finally {
          running = false;
        }
      };
    },
    complete() {
      bodyClosed = true;
      const pinned = uncertain || invoking !== 0 || epoch !== originalEpoch || cleanups.size !== 0 || failures.length !== 0 ||
        [...originals.values()].some((record) => !record.settled || record.failed);
      uncertain = pinned;
      if (!pinned) retainedEffects.delete(owner);
      return { status: pinned ? "PINNED" as const : "RELEASED" as const, failures: [...failures] };
    },
  });
}
