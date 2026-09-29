import { mkdir, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const writers = new Map<string, Promise<void>>();

async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let bytes = 0;
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(filename);
    else if (entry.isFile()) bytes += await stat(filename).then(info => info.size).catch(error => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
  }
  return bytes;
}

// One Meeting worker owns decoding. Serialize its writers across all sessions;
// count files on disk so restarts, failed cleanup and temporary WAVs retain quota.
export class MeetingLiveAudioQuota {
  private readonly root: string;
  constructor(processingDir: string, private readonly maxBytes: number,
    private readonly minFreeBytes: number) { this.root = path.resolve(processingDir); }

  async write(audioPath: string, wave: Buffer): Promise<boolean> {
    const previous = writers.get(this.root) ?? Promise.resolve();
    const writing = previous.then(async () => {
      await mkdir(this.root, { recursive: true });
      let used = 0;
      for (const session of await readdir(this.root, { withFileTypes: true })) {
        if (session.isDirectory()) used += await directoryBytes(path.join(this.root, session.name, "live-transcript"));
      }
      const disk = await statfs(this.root);
      if (used + wave.length > this.maxBytes || disk.bavail * disk.bsize - wave.length < this.minFreeBytes) return false;
      await mkdir(path.dirname(audioPath), { recursive: true });
      const temporary = `${audioPath}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, wave); await rename(temporary, audioPath); }
      finally { await rm(temporary, { force: true }); }
      return true;
    });
    const tail = writing.then(() => undefined, () => undefined);
    writers.set(this.root, tail);
    try { return await writing; }
    finally { if (writers.get(this.root) === tail) writers.delete(this.root); }
  }
}
