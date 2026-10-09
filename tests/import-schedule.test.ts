import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

describe('schedule SQL import',()=>{
 it('generates remote-compatible, inactive and idempotent seed SQL',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sogang-schedule-'));const db=new DatabaseSync(':memory:');
  try {
   const output=join(dir,'schedule.sql');
   execFileSync(process.execPath,['scripts/import-schedule.mjs',`--output=${output}`]);
   const sql=readFileSync(output,'utf8');
   expect(sql).not.toMatch(/\b(BEGIN|COMMIT|SAVEPOINT)\b/i);
   db.exec('CREATE TABLE schedules(id TEXT PRIMARY KEY,data TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0)');
   db.exec(sql);db.exec(sql);
   expect(db.prepare('SELECT COUNT(*) AS total,SUM(active) AS approved FROM schedules').get()).toEqual({total:27,approved:0});
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
 });
});
