export class SingleFlightCache<Key, Value> {
  private readonly entries = new Map<Key, { at: number; value: Value }>();
  private readonly inFlight = new Map<Key, Promise<Value>>();

  constructor(
    private readonly maxAgeMs: number,
    private readonly now: () => number,
  ) {}

  peek(key: Key): { at: number; value: Value } | null {
    return this.entries.get(key) ?? null;
  }

  async get(key: Key, load: () => Promise<Value>): Promise<Value> {
    const cached = this.entries.get(key);
    if (cached !== undefined && this.now() - cached.at < this.maxAgeMs)
      return cached.value;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const started = (async () => {
      try {
        const value = await load();
        this.entries.set(key, { at: this.now(), value });
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, started);
    return started;
  }

  forget(key: Key): void {
    this.entries.delete(key);
  }
}
