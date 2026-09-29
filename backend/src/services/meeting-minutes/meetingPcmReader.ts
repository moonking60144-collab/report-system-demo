import { open, type FileHandle } from "node:fs/promises";
import { PCM_BYTES_PER_MS } from "./meetingLiveAudio";

async function readExactly(file: FileHandle, size: number, position: number): Promise<Buffer> {
  const result = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(result, offset, size-offset, position+offset);
    if (!bytesRead) throw new Error("Truncated canonical PCM WAV");
    offset += bytesRead;
  }
  return result;
}

export class MeetingPcmReader {
  private constructor(private readonly file: FileHandle, private readonly offset: number, private readonly size: number) {}

  static async open(filename: string): Promise<MeetingPcmReader | null> {
    const file = await open(filename, "r");
    let reader: MeetingPcmReader | null = null;
    try {
      const size = (await file.stat()).size;
      if (size < 12) return null;
      const header = await readExactly(file,12,0);
      if (header.toString("ascii",0,4) !== "RIFF" || header.toString("ascii",8,12) !== "WAVE") return null;
      let pcm = false;
      for (let offset = 12; offset+8 <= size;) {
        const chunk = await readExactly(file,8,offset);
        const length = chunk.readUInt32LE(4);
        const start = offset+8;
        if (start+length > size) return null;
        const kind = chunk.toString("ascii",0,4);
        if (kind === "fmt ") {
          if (length < 16) return null;
          const fmt = await readExactly(file,16,start);
          pcm = fmt.readUInt16LE(0) === 1 && fmt.readUInt16LE(2) === 1 && fmt.readUInt32LE(4) === 16000
            && fmt.readUInt32LE(8) === 32000 && fmt.readUInt16LE(12) === 2 && fmt.readUInt16LE(14) === 16;
        }
        if (kind === "data") {
          if (!pcm || length % 2 !== 0) return null;
          reader = new MeetingPcmReader(file,start,length);
          return reader;
        }
        offset = start+length+(length%2);
      }
      return null;
    } finally { if (!reader) await file.close(); }
  }

  async readWindow(startMs: number, endMs: number): Promise<Buffer> {
    const start = Math.min(this.size,Math.max(0,Math.trunc(startMs*PCM_BYTES_PER_MS)));
    const end = Math.min(this.size,Math.max(start,Math.trunc(endMs*PCM_BYTES_PER_MS)));
    return readExactly(this.file,end-start,this.offset+start);
  }

  close() { return this.file.close(); }
}
