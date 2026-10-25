/**
 * Captions from the server's subtitle route. The server converts every
 * supported format to a small WebVTT subset, so this parser only needs cue
 * timings and text. Styling tags are dropped; line breaks are kept.
 * One malformed cue is skipped rather than rejecting the whole file.
 */
export type Cue = { start: number; end: number; text: string };

const TIMING =
  /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const MAX_CUES = 20000;

function seconds(
  hours: string | undefined,
  minutes: string,
  secs: string,
  fraction: string,
): number {
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(secs) +
    Number(fraction.padEnd(3, '0')) / 1000
  );
}

function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

export function parseVtt(source: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = source.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const match = TIMING.exec(lines[timingIndex]!.trim());
    if (!match) continue;
    const start = seconds(match[1], match[2]!, match[3]!, match[4]!);
    const end = seconds(match[5], match[6]!, match[7]!, match[8]!);
    const text = plain(lines.slice(timingIndex + 1).join('\n'));
    if (!(end > start) || !text) continue;
    cues.push({ start, end, text });
    if (cues.length >= MAX_CUES) break;
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * Text for the given time, joining overlapping cues. Binary search keeps
 * this cheap enough to call on every player time update.
 */
export function cueTextAt(cues: readonly Cue[], time: number): string {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cues[middle]!.start <= time) low = middle + 1;
    else high = middle;
  }
  const active: string[] = [];
  // Cues are short; look back a bounded distance for ones still running.
  for (let index = low - 1; index >= 0 && index >= low - 8; index -= 1) {
    const cue = cues[index]!;
    if (cue.end > time) active.unshift(cue.text);
  }
  return active.join('\n');
}
