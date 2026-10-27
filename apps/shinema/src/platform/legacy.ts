import { File, Paths } from 'expo-file-system';

/**
 * The previous Android TV client saved its state in its private files
 * folder. This app uses the same package name, so after an in-place upgrade
 * that file is still here; it is read once and left untouched.
 */
export async function readLegacyState(): Promise<{
  text: string;
  modifiedAt: number;
} | null> {
  try {
    const file = new File(Paths.document, 'client-state.json');
    if (!file.exists) return null;
    const text = await file.text();
    const modifiedAt = file.info().modificationTime ?? Date.now();
    return { text, modifiedAt };
  } catch {
    return null;
  }
}
