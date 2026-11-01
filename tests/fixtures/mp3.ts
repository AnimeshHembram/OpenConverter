/** MP3 frame parsing for tests: checks what an encoder actually wrote. */

/**
 * Every MPEG audio frame in an MP3: its bitrate (kbit/s) and sample rate.
 * The first frame may be a "Xing"/"Info" header frame (it describes the
 * stream rather than holding sound), which is reported separately.
 */
export function mp3Frames(bytes: Uint8Array): { info: boolean; frames: { kbps: number; rate: number }[] } {
  let i = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) i = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  const KBPS = { v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
  const RATES = { v1: [44_100, 48_000, 32_000], v2: [22_050, 24_000, 16_000] };
  const frames: { kbps: number; rate: number }[] = [];
  let info = false;
  while (i < bytes.length - 4) {
    if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const v = ((bytes[i + 1]! >> 3) & 3) === 3 ? 'v1' : 'v2';
    const kbps = KBPS[v][bytes[i + 2]! >> 4]!;
    const rate = RATES[v][(bytes[i + 2]! >> 2) & 3]!;
    const length = Math.floor(((v === 'v1' ? 144_000 : 72_000) * kbps) / rate) + ((bytes[i + 2]! >> 1) & 1);
    const body = String.fromCharCode(...bytes.subarray(i + 4, i + 40));
    if (!frames.length && !info && /Xing|Info/.test(body)) info = true;
    else frames.push({ kbps, rate });
    i += Math.max(1, length);
  }
  return { info, frames };
}
