#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateSchedules } from '../src/schedule.ts';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--approve' && !arg.startsWith('--input=') && !arg.startsWith('--output='))) {
  throw new Error('Usage: npm run schedule:import -- [--approve] [--input=PATH] [--output=PATH]');
}
const input = args.find(arg => arg.startsWith('--input='))?.slice(8) ?? 'data/schedule.json';
const output = args.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'data/schedule.sql';
const approved = args.includes('--approve');
const schedules = validateSchedules(JSON.parse(await readFile(resolve(input), 'utf8')));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const statements = schedules.map(item => {
  const active = approved && !item.note.includes('교직원 대상');
  const data = { ...item, active };
  return `INSERT INTO schedules (id, data, active) VALUES (${quote(item.id)}, ${quote(JSON.stringify(data))}, ${active ? 1 : 0}) ON CONFLICT(id) DO UPDATE SET data=excluded.data, active=excluded.active;`;
});
// Remote D1 import provides its own transaction and rejects explicit BEGIN/COMMIT.
await writeFile(resolve(output), `-- Generated locally; ${approved ? 'review approved' : 'NOT approved for notifications'}. Never deletes absent IDs.\n${statements.join('\n')}\n`);
console.log(`Wrote ${schedules.length} schedules to ${output}; notifications ${approved ? 'approved (faculty deadlines excluded)' : 'disabled'}. No database command was executed.`);
