// A small LRU for expensive page backgrounds. Dropping an entry drops only our reference:
// another render may still be copying the same surface, so eviction must never resize it.
interface Entry<T> {
  promise: Promise<T>;
  bytes: number;
}

export class BoundedRasterCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private retainedBytes = 0;

  constructor(
    readonly maxBytes = 64 * 1024 * 1024,
    readonly maxEntries = 4,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
        !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError('Raster cache limits must be non-negative safe integers');
    }
  }

  get size(): number { return this.entries.size; }
  /** Estimated bytes reserved by retained entries, including their pending creations.
   * Caller-held surfaces and evicted/in-flight work are outside this cache's budget. */
  get bytes(): number { return this.retainedBytes; }

  get(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.promise;
  }

  getOrCreate(key: string, bytes: number, create: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError('Raster byte estimate must be a non-negative safe integer');
    }
    const cached = this.get(key);
    if (cached) return cached;

    // Defer the factory so synchronous failures use the same rejection/cleanup path.
    // The entry is installed before creation starts, allowing simultaneous readers to join.
    let promise: Promise<T>;
    promise = Promise.resolve().then(create).catch((error: unknown) => {
      if (this.entries.get(key)?.promise === promise) this.remove(key);
      throw error;
    });
    // Oversized backgrounds still render, without displacing useful smaller entries or
    // retaining their result here. A disabled cache likewise leaves ownership to the caller.
    if (this.maxEntries > 0 && bytes <= this.maxBytes) {
      this.entries.set(key, { promise, bytes });
      this.retainedBytes += bytes;
      while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
        this.remove(this.entries.keys().next().value!);
      }
    }
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
    // Completion never inserts an entry, so work started before clear() cannot resurrect it.
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.retainedBytes -= entry.bytes;
  }
}
