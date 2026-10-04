import { open } from "node:fs/promises";

/**
 * Just enough of the asar format to find one file inside Paseo's archive and overwrite
 * it in place.
 *
 * An asar is a JSON header followed by every file's bytes, concatenated. Each entry
 * carries a `size` and an `offset` relative to where the data starts, so a replacement
 * of exactly the same length can be written straight over the old bytes and the header
 * stays true. Anything that changes a length means rebuilding 112 MB and reproducing the
 * unpacked-file flags by hand, which is why the caller pads to fit instead.
 */

/**
 * Electron routes `fs` through its own asar reader for any path containing `.asar`,
 * which turns a plain read of the archive itself into ENOENT. This switch turns that
 * interception off for the duration of the call.
 */
async function withoutAsar<T>(work: () => Promise<T>): Promise<T> {
  const host = process as { noAsar?: boolean };
  const previous = host.noAsar;
  host.noAsar = true;
  try {
    return await work();
  } finally {
    host.noAsar = previous;
  }
}

type Node = { files?: Record<string, Node>; size?: number; offset?: string; unpacked?: boolean };

export type Archive = { path: string; header: Node; dataOffset: number };

/** Where one file's bytes sit in the archive, as absolute positions in it. */
export type Entry = { offset: number; size: number };

export async function readArchive(file: string): Promise<Archive> {
  return withoutAsar(async () => {
    const handle = await open(file, "r");
    try {
      /**
       * Two nested pickles, and the nesting is the trap. Each pickle begins with its
       * own payload length, so the outer one gives the size of the inner, and inside
       * the inner there is a string length before the JSON itself. Reading the JSON
       * four bytes early yields a parse error on what looks like valid data.
       */
      const sizes = Buffer.alloc(8);
      await handle.read(sizes, 0, 8, 0);
      const headerSize = sizes.readUInt32LE(4);
      if (headerSize <= 8 || headerSize > 64 * 1024 * 1024) {
        throw new Error(`не похоже на asar: заголовок ${headerSize} байт`);
      }
      const pickle = Buffer.alloc(headerSize);
      await handle.read(pickle, 0, headerSize, 8);
      const jsonSize = pickle.readUInt32LE(4);
      const header = JSON.parse(pickle.subarray(8, 8 + jsonSize).toString("utf8")) as Node;
      return { path: file, header, dataOffset: 8 + headerSize };
    } finally {
      await handle.close();
    }
  });
}

/**
 * Walks the nested header down to one path. Returns null for a file that is missing, or
 * one that was left unpacked — an unpacked entry has no offset, because its bytes live
 * in `app.asar.unpacked` beside the archive rather than inside it.
 */
export function locate(archive: Archive, entryPath: string): Entry | null {
  let node: Node | undefined = archive.header;
  for (const part of entryPath.split("/")) {
    node = node?.files?.[part];
    if (!node) {
      return null;
    }
  }
  if (node.unpacked || node.offset === undefined || node.size === undefined) {
    return null;
  }
  return { offset: archive.dataOffset + Number(node.offset), size: node.size };
}

export async function readEntry(file: string, entry: Entry): Promise<Buffer> {
  return withoutAsar(async () => {
    const handle = await open(file, "r");
    try {
      const bytes = Buffer.alloc(entry.size);
      await handle.read(bytes, 0, entry.size, entry.offset);
      return bytes;
    } finally {
      await handle.close();
    }
  });
}

/**
 * Overwrites one entry. The length is checked rather than trusted: a short write would
 * leave the following file's bytes shifted under a header that still points at the old
 * places, which is a corrupt archive with no error message.
 */
export async function writeEntry(file: string, entry: Entry, bytes: Buffer): Promise<void> {
  if (bytes.length !== entry.size) {
    throw new Error(`замена ${bytes.length} байт не совпадает с ${entry.size} в архиве`);
  }
  await withoutAsar(async () => {
    const handle = await open(file, "r+");
    try {
      await handle.write(bytes, 0, bytes.length, entry.offset);
    } finally {
      await handle.close();
    }
  });
}
