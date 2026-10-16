/** User interaction wins over delayed startup I/O; connection work has one owner. */
export class NativeActivity {
  private revision = 0;
  private connection: AbortController | undefined;

  capture(): number {
    return this.revision;
  }
  current(revision: number): boolean {
    return revision === this.revision;
  }
  interact(): void {
    ++this.revision;
  }
  connecting(): boolean {
    return this.connection !== undefined;
  }
  beginConnection(): AbortSignal {
    this.cancelConnection();
    this.connection = new AbortController();
    return this.connection.signal;
  }
  cancelConnection(): void {
    this.interact();
    this.connection?.abort();
    this.connection = undefined;
  }
  finishConnection(signal: AbortSignal): void {
    if (this.connection?.signal === signal) this.connection = undefined;
  }
  async read<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error('Canceled library request');
    const value = await operation();
    // Some transports still settle after abort. Do not start the next request.
    if (signal.aborted) throw new Error('Canceled library request');
    return value;
  }
}

/** Durable recovery precedes activation and writes, independently of presentation. */
export class StartupHydration<T> {
  private pending: Promise<T> | undefined;
  private read: () => Promise<T>;
  private hydrate: (value: T) => void;

  constructor(read: () => Promise<T>, hydrate: (value: T) => void) {
    this.read = read;
    this.hydrate = hydrate;
  }

  ready(): Promise<T> {
    if (this.pending) return this.pending;
    const work = Promise.resolve()
      .then(() => this.read())
      .then((value) => {
        this.hydrate(value);
        return value;
      });
    this.pending = work;
    // A failed read is not evidence of an empty cache. Let an explicit retry
    // read it again, while refusing writes against an unknown durable base.
    void work.catch(() => {
      if (this.pending === work) this.pending = undefined;
    });
    return work;
  }

  async run<R>(operation: () => Promise<R>): Promise<R> {
    await this.ready();
    return operation();
  }
}
