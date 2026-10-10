import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, dayDifference, todayKst, validDate } from '../src/time';
import { dueReminders, upcomingSchedules, validateSchedules } from '../src/schedule';
import type { Schedule } from '../src/types';
import seed from '../data/schedule.json';

const entry = (changes: Partial<Schedule> = {}): Schedule => ({ id: 'test-deadline', title: '신청', startDate: '2026-10-01', endDate: '2026-10-20', deadlineDate: '2026-10-20', type: 'period', sourceUrl: 'https://www.sogang.ac.kr/ko/academic-support/calendar', lastReviewed: '2026-10-09', note: '시각 미기재', active: true, ...changes });

describe('Asia/Seoul date-only calculations', () => {
  it('crosses midnight KST at 15:00 UTC, without local timezone dependence', () => {
    expect(todayKst(new Date('2026-10-09T14:59:59Z'))).toBe('2026-10-09');
    expect(todayKst(new Date('2026-10-09T15:00:00Z'))).toBe('2026-10-10');
  });
  it('validates actual calendar dates and leap years', () => {
    expect(validDate('2024-02-29')).toBe(true);
    for (const invalid of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '2026-01-00', 'not-a-date', null]) expect(validDate(invalid)).toBe(false);
  });
  it('handles calendar day arithmetic across year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(dayDifference('2026-12-31', '2027-01-07')).toBe(7);
    expect(() => addDays('2026-02-30', 1)).toThrow();
    expect(() => addDays('2026-10-09', 0.5)).toThrow();
  });
});

describe('reviewed schedules', () => {
  it('keeps real verified seeds inactive pending human review and contains no invented cutoff', () => {
    const rows = validateSchedules(seed);
    expect(rows).toHaveLength(27);
    expect(rows.every(row => row.active === false && !row.deadlineAt)).toBe(true);
    expect(rows.find(row => row.id === '2027-entrance')?.startDate).toBe('2027-02-18');
    expect(dueReminders(rows, '2026-11-20')).toEqual([]);
  });
  it('includes ongoing periods but excludes past events and the exclusive day-30 boundary', () => {
    const rows = [entry({ id: 'ongoing', deadlineDate: undefined }), entry({ id: 'expired', startDate: '2026-09-01', endDate: '2026-09-30', deadlineDate: undefined }), entry({ id: 'future', startDate: '2026-11-08', endDate: undefined, deadlineDate: undefined, type: 'event' })];
    expect(upcomingSchedules(rows, '2026-10-09').map(row => row.id)).toEqual(['ongoing']);
  });
  it('only reminds D-7, D-1 and D-day and never treats every event as a deadline', () => {
    const rows = [entry(), entry({ id: 'semester-start', deadlineDate: undefined, endDate: undefined, type: 'event' }), entry({ id: 'unapproved', active: false }), entry({ id: 'faculty', note: '교직원 대상 성적 제출 일정. 학생 신청 마감이 아님.' })];
    expect(dueReminders(rows, '2026-10-13').map(row => row.offset)).toEqual([7]);
    expect(dueReminders(rows, '2026-10-19').map(row => row.offset)).toEqual([1]);
    expect(dueReminders(rows, '2026-10-20').map(row => row.offset)).toEqual([0]);
    expect(dueReminders(rows, '2026-10-21')).toEqual([]);
    expect(dueReminders(rows, '2026-10-18')).toEqual([]);
    expect(rows[0].deadlineAt).toBeUndefined();
  });
  it('reminds exam periods and events at their start without inventing end deadlines', () => {
    const exam = entry({ id: 'exam', startDate: '2026-10-20', endDate: '2026-10-26', deadlineDate: undefined });
    const event = entry({ id: 'registration', startDate: '2026-10-20', type: 'event', endDate: undefined, deadlineDate: undefined });
    for (const [today, offset] of [['2026-10-13', 7], ['2026-10-19', 1], ['2026-10-20', 0]] as const) {
      expect(dueReminders([exam, event], today).map(({ item, kind, date, offset: actual }) => [item.id, kind, date, actual])).toEqual([['exam', 'start', '2026-10-20', offset], ['registration', 'start', '2026-10-20', offset]]);
    }
    expect(dueReminders([exam], '2026-10-26')).toEqual([]);
  });
  it('reminds both application start and explicit deadline with no same-date duplication', () => {
    const application = entry({ startDate: '2026-11-01', endDate: '2026-11-30', deadlineDate: '2026-11-30' });
    expect(dueReminders([application], '2026-10-25')[0]).toMatchObject({kind:'start',date:'2026-11-01',offset:7});
    expect(dueReminders([application], '2026-11-23')[0]).toMatchObject({kind:'deadline',date:'2026-11-30',offset:7});
    const single = entry({ startDate:'2026-10-20' });
    expect(dueReminders([single], '2026-10-20')).toHaveLength(1);
    expect(dueReminders([single], '2026-10-20')[0].kind).toBe('deadline');
    expect(dueReminders([entry({type:'deadline',startDate:'2026-10-01'})], '2026-10-01')).toEqual([]);
  });
  it('excludes unapproved and faculty start reminders too', () => {
    const start = entry({startDate:'2026-10-20',deadlineDate:undefined});
    expect(dueReminders([{...start,active:false},{...start,id:'faculty',note:'교직원 대상'}], '2026-10-13')).toEqual([]);
  });
  it('maps explicit timestamp deadlines to KST dates but rejects ambiguous or invalid timestamps', () => {
    const row = entry({ deadlineDate: undefined, deadlineAt: '2026-10-19T15:00:00Z' });
    expect(validateSchedules([row])).toHaveLength(1);
    expect(dueReminders([row], '2026-10-20')[0].offset).toBe(0);
    for (const bad of ['2026-10-20T24:00:00+09:00', '2026-02-30T12:00:00+09:00', '2026-10-20T12:00:00', '2026-10-20T12:60:00+09:00']) expect(() => validateSchedules([entry({ deadlineDate: undefined, deadlineAt: bad })])).toThrow();
    expect(() => validateSchedules([entry({ deadlineAt: '2026-10-20T12:00:00+09:00' })])).toThrow();
  });
  it('imports locally with explicit approval, stable-ID upserts and no automatic faculty reminders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sogang-schedule-test-'));
    const input = join(dir, 'input.json');
    const output = join(dir, 'output.sql');
    writeFileSync(input, JSON.stringify([entry(), entry({ id: 'faculty', note: '교직원 대상 성적 제출 일정.' })]));
    execFileSync(process.execPath, ['scripts/import-schedule.mjs', `--input=${input}`, `--output=${output}`]);
    let sql = readFileSync(output, 'utf8');
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(sql).not.toContain('DELETE');
    expect(sql).not.toContain('"active":true');
    execFileSync(process.execPath, ['scripts/import-schedule.mjs', '--approve', `--input=${input}`, `--output=${output}`]);
    sql = readFileSync(output, 'utf8');
    expect(sql.split('\n').find(line => line.includes("VALUES ('test-deadline'"))).toContain('"active":true');
    expect(sql.split('\n').find(line => line.includes("VALUES ('faculty'"))).toContain('"active":false');
    writeFileSync(input, JSON.stringify([entry({ deadlineDate: '2026-02-30' })]));
    expect(() => execFileSync(process.execPath, ['scripts/import-schedule.mjs', `--input=${input}`, `--output=${output}`], { stdio: 'pipe' })).toThrow();
  });
  it('rejects duplicate IDs, invalid periods, unofficial sources and malformed approval states', () => {
    expect(() => validateSchedules([entry(), entry()])).toThrow();
    expect(() => validateSchedules([entry({ endDate: '2026-09-30' })])).toThrow();
    expect(() => validateSchedules([entry({ sourceUrl: 'https://sogang.ac.kr.attacker.example/calendar' })])).toThrow();
    expect(() => validateSchedules([entry({ sourceUrl: 'http://www.sogang.ac.kr/calendar' })])).toThrow();
    expect(() => validateSchedules([entry({ active: 'true' as unknown as boolean })])).toThrow();
    expect(() => validateSchedules([entry({ deadlineDate: undefined, endDate: undefined, type: 'deadline' })])).toThrow();
  });
});
