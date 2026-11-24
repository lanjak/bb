const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const MAX_PLAIN_LENGTH = 300;
const ANSI =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatPercent(percent: number): string {
  return `${percent >= 100 ? Math.round(percent) : percent.toFixed(1)}%`;
}

export function plain(text: string): string {
  const cleaned = text.replace(ANSI, "").replace(CONTROL, " ").trim();
  return cleaned.length > MAX_PLAIN_LENGTH
    ? `${cleaned.slice(0, MAX_PLAIN_LENGTH - 3)}...`
    : cleaned;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
