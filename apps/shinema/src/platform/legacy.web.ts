/** The old web preview kept no unsynced progress worth carrying over. */
export async function readLegacyState(): Promise<{
  text: string;
  modifiedAt: number;
} | null> {
  return null;
}
