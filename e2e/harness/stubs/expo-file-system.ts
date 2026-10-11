/**
 * Imported by Paseo's audio engine alongside `expo-audio`, for the temporary files encoded
 * audio is played from — which is how MP3 speech reaches the phone's speaker. Kept in
 * memory: the player stand-in in `expo-audio.ts` reads them back by URI.
 */

const files = new Map<string, Uint8Array>();

export const Paths = { cache: "harness-cache" };

export class File {
  readonly uri: string;

  constructor(directory: unknown, name: string) {
    this.uri = `file:///${String(directory)}/${name}`;
  }

  write(bytes: Uint8Array): void {
    files.set(this.uri, Uint8Array.from(bytes));
  }

  get exists(): boolean {
    return files.has(this.uri);
  }

  delete(): void {
    files.delete(this.uri);
  }
}

/** For the player stand-in: what was written at `uri`. */
export function readFile(uri: string): Uint8Array | undefined {
  return files.get(uri);
}
