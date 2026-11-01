/** MP3 bitrate choices and small helpers, shared by the UI and the converter. */

/** MP3 bitrates offered, in kbit/s. */
export const AUDIO_BITRATES = [320, 256, 192, 128, 96, 64] as const;
export const DEFAULT_AUDIO_BITRATE = 128;

/** Nearest offered bitrate, so a stale or odd setting can't reach the encoder. */
export function normaliseBitrate(kbps: number | undefined): number {
  if (!kbps || !Number.isFinite(kbps)) return DEFAULT_AUDIO_BITRATE;
  return AUDIO_BITRATES.reduce((best, b) => (Math.abs(b - kbps) < Math.abs(best - kbps) ? b : best), DEFAULT_AUDIO_BITRATE as number);
}

/** m:ss or h:mm:ss */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
