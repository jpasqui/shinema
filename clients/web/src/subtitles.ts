/** Per-item choices last for the page session, with no persisted library data. */
export class SubtitlePreferences {
  private values = new Map<string, string>();
  get(id: string): string | undefined {
    return this.values.get(id);
  }
  set(id: string, choice: string | undefined): void {
    this.values.delete(id);
    if (choice !== undefined) this.values.set(id, choice);
    if (this.values.size > 128)
      this.values.delete(this.values.keys().next().value!);
  }
}

async function subtitleText(
  path: string,
  signal: AbortSignal,
  limit: number,
): Promise<string> {
  const response = await fetch(path, {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(50000)]),
  });
  if (!response.ok || !response.body) throw new Error('Subtitle unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error('Subtitle exceeds limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function subtitleManifest(
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  return JSON.parse(await subtitleText(path, signal, 256 * 1024));
}

export async function subtitleContent(
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const content = await subtitleText(path, signal, 4 * 1024 * 1024);
  if (!content.startsWith('WEBVTT\n'))
    throw new Error('Invalid subtitle content');
  return content;
}
