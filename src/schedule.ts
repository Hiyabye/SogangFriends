import type { Schedule } from './types';
import { addDays, dayDifference, todayKst, validDate } from './time';

function deadlineDate(item: Schedule): string | undefined {
  return item.deadlineDate ?? (item.deadlineAt ? todayKst(new Date(item.deadlineAt)) : undefined);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  if (!validDate(value.slice(0, 10))) return false;
  const [, hour, minute, second = '0', zoneHour = '0', zoneMinute = '0'] = value.match(/T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-](\d{2}):(\d{2}))$/) ?? [];
  return Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 && Number(zoneHour) <= 14 && Number(zoneMinute) < 60 && Number.isFinite(Date.parse(value));
}

/** Validate reviewed local data; this does not verify the school's published facts. */
export function validateSchedules(value: unknown): Schedule[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid schedule list');
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid schedule entry');
    const item = raw as Schedule;
    if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(item.id) || seen.has(item.id)) throw new Error('Invalid or duplicate schedule ID');
    seen.add(item.id);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300 || typeof item.note !== 'string' || item.note.length > 1000) throw new Error('Invalid schedule text');
    if (!validDate(item.startDate) || !validDate(item.lastReviewed) || !['event', 'period', 'deadline'].includes(item.type)) throw new Error('Invalid schedule date/type');
    if (item.endDate !== undefined && (!validDate(item.endDate) || item.endDate < item.startDate)) throw new Error('Invalid schedule period');
    if (item.deadlineDate !== undefined && !validDate(item.deadlineDate)) throw new Error('Invalid deadline date');
    if (item.deadlineAt !== undefined && !validTimestamp(item.deadlineAt)) throw new Error('Invalid explicit deadline timestamp');
    if (item.deadlineDate !== undefined && item.deadlineAt !== undefined) throw new Error('Ambiguous deadline');
    const deadline = deadlineDate(item);
    if (deadline && (deadline < item.startDate || (item.endDate && deadline > item.endDate))) throw new Error('Deadline outside schedule period');
    if ((item.type === 'deadline' && !deadline) || (item.type === 'event' && deadline)) throw new Error('Invalid deadline semantics');
    if (item.active !== undefined && typeof item.active !== 'boolean') throw new Error('Invalid approval state');
    try {
      const url = new URL(item.sourceUrl);
      if (url.protocol !== 'https:' || !(url.hostname === 'sogang.ac.kr' || url.hostname.endsWith('.sogang.ac.kr')) || url.username || url.password || url.port) throw new Error();
    } catch { throw new Error('Invalid official schedule source'); }
  }
  return value as Schedule[];
}

/** Today inclusive, with an exclusive today+30 boundary; includes ongoing periods. */
export function upcomingSchedules(items: Schedule[], today: string): Schedule[] {
  const end = addDays(today, 30);
  return items.filter(item => (item.endDate ?? deadlineDate(item) ?? item.startDate) >= today && item.startDate < end)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
}

/** Start dates are not deadlines; only explicitly documented deadlines get end reminders. */
export function dueReminders(items: Schedule[], today: string): { item: Schedule; offset: number; kind: 'start' | 'deadline'; date: string }[] {
  if (!validDate(today)) throw new Error('Invalid reminder date');
  return items.flatMap(item => {
    if (item.active !== true || item.note.includes('교직원 대상')) return [];
    const deadline = deadlineDate(item);
    const targets: { kind: 'start' | 'deadline'; date: string }[] = [];
    // One reminder if a period starts and ends on the same KST date.
    if (item.type !== 'deadline' && item.startDate !== deadline) targets.push({ kind: 'start', date: item.startDate });
    if (deadline) targets.push({ kind: 'deadline', date: deadline });
    return targets.flatMap(({ kind, date }) => {
      const offset = dayDifference(today, date);
      return [7, 1, 0].includes(offset) ? [{ item, offset, kind, date }] : [];
    });
  });
}
