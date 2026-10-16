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
