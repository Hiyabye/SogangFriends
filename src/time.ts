const DAY_MS = 86_400_000;

/** Calendar dates are date-only values, not invented end-of-day timestamps. */
export function validDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function dateMillis(date: string): number {
  if (!validDate(date)) throw new Error('Invalid calendar date');
  return Date.parse(`${date}T00:00:00Z`);
}

export function todayKst(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid clock');
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error('Invalid day offset');
  const result = new Date(dateMillis(date) + n * DAY_MS).toISOString().slice(0, 10);
  if (!validDate(result)) throw new Error('Date outside supported range');
  return result;
}

export function dayDifference(from: string, to: string): number {
  return (dateMillis(to) - dateMillis(from)) / DAY_MS;
}
