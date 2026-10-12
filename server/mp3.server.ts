import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * MP3, for the agent's voice on its way to the phone.
 *
 * Raw 24 kHz PCM is 48 KB a second of speech, and each sentence crosses the relay as one
 * message the phone has to receive whole before it can start: measured on a phone, two
 * seconds of waiting before a thirteen-second sentence. Google's MP3 is 64 kbps, a sixth
 * of that, and has no setting for less. Google encodes it itself; the local engine's PCM
 * is encoded here, at the same rate so that both providers sound alike.
 */

export const MP3_KBPS = 64;

/** Kilobits a second of each Layer III bitrate index, by MPEG version. */
const KBPS_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000], // MPEG-1
  2: [22_050, 24_000, 16_000], // MPEG-2
  0: [11_025, 12_000, 8_000], // MPEG-2.5
};

type Frame = { length: number; samples: number; rate: number };

/** The Layer III frame starting at `at`, or null if there is none there. */
function frameAt(mp3: Uint8Array, at: number): Frame | null {
  if (at + 4 > mp3.length || mp3[at] !== 0xff || ((mp3[at + 1] ?? 0) & 0xe0) !== 0xe0) {
    return null;
  }
  const b1 = mp3[at + 1] ?? 0;
  const b2 = mp3[at + 2] ?? 0;
  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  const rate = RATES[version]?.[(b2 >> 2) & 3];
  const kbps = (version === 3 ? KBPS_MPEG1 : KBPS_MPEG2)[(b2 >> 4) & 0xf] ?? 0;
  if (layer !== 1 || !rate || kbps === 0) {
    return null;
  }
  const padding = (b2 >> 1) & 1;
  const mpeg1 = version === 3;
  return {
    length: Math.floor(((mpeg1 ? 144_000 : 72_000) * kbps) / rate) + padding,
    samples: mpeg1 ? 1152 : 576,
    rate,
  };
}

/** Where the audio starts, past an ID3v2 tag if the file opens with one. */
function audioStart(mp3: Uint8Array): number {
  if (mp3.length < 10 || mp3[0] !== 0x49 || mp3[1] !== 0x44 || mp3[2] !== 0x33) {
    return 0;
  }
  // A syncsafe size: seven bits a byte.
  const size = (((mp3[6] ?? 0) & 0x7f) << 21) | (((mp3[7] ?? 0) & 0x7f) << 14) | (((mp3[8] ?? 0) & 0x7f) << 7) | ((mp3[9] ?? 0) & 0x7f);
  const footer = ((mp3[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * How long an MP3 plays, in seconds, by walking its frames. A byte that is not the start
 * of a frame is skipped rather than trusted, so stray data costs nothing but time.
 */
export function mp3Duration(mp3: Uint8Array): number {
  let seconds = 0;
  for (let at = audioStart(mp3); at < mp3.length; ) {
    const frame = frameAt(mp3, at);
    if (!frame) {
      at += 1;
      continue;
    }
    seconds += frame.samples / frame.rate;
    at += frame.length;
  }
  return seconds;
}

/** Whether these bytes are an MP3 at all: a frame where the audio should start. */
export function isMp3(bytes: Uint8Array): boolean {
  return frameAt(bytes, audioStart(bytes)) !== null;
}

/** Homebrew's places as well as PATH: a daemon started from the Dock has a short PATH. */
function which(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) {
    if (dir && existsSync(`${dir}/${name}`)) {
      return `${dir}/${name}`;
    }
  }
  return null;
}

/** The encoder this Mac has, with the arguments that turn raw mono PCM into MP3. */
function encoder(rate: number, kbps: number): { command: string; args: string[] } | null {
  const lame = which("lame");
  if (lame) {
    return {
      command: lame,
      args: ["--quiet", "-r", "-s", String(rate / 1000), "--bitwidth", "16", "--signed", "--little-endian", "-m", "m", "-b", String(kbps), "-", "-"],
    };
  }
  const ffmpeg = which("ffmpeg");
  if (ffmpeg) {
    return {
      command: ffmpeg,
      args: ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-f", "mp3", "pipe:1"],
    };
  }
  return null;
}

export function canEncodeMp3(): boolean {
  return encoder(24_000, MP3_KBPS) !== null;
}

/** Mono PCM16 at `rate` to MP3, through `lame` or else `ffmpeg`. */
export function encodeMp3(pcm: Buffer, rate = 24_000, kbps = MP3_KBPS): Promise<Buffer> {
  const found = encoder(rate, kbps);
  if (!found) {
    return Promise.reject(new Error("MP3 needs lame or ffmpeg: brew install lame"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(found.command, found.args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on("error", (failure) => {
      clearTimeout(timer);
      reject(failure);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(new Error(`MP3: ${found.command} exited ${code}: ${errors.trim().slice(0, 200)}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(pcm);
  });
}
