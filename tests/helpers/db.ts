import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import type { Env } from '../../src/types';

/** Real SQLite SQL execution behind the small D1 surface used by the Worker. */
export function testDatabase() {
 const sqlite = new DatabaseSync(':memory:');
 const directory = resolve('migrations');
 for (const file of readdirSync(directory).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(directory,file),'utf8'));
 class Statement {
  constructor(readonly sql:string, readonly values:unknown[] = []) {}
  bind(...values:unknown[]) { return new Statement(this.sql, values); }
  execute() {
   const statement=sqlite.prepare(this.sql);
   const isRows=/^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql)||/\bRETURNING\b/i.test(this.sql);
   if(isRows) {
    const results=statement.all(...this.values as never[]);
    const changes=Number(sqlite.prepare('SELECT changes() AS count').get()!.count);
    return {success:true,results,meta:{changes}};
   }
   const result=statement.run(...this.values as never[]);
   return {success:true,results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};
  }
  async run() {return this.execute();}
  async all() {return this.execute();}
  async first(column?:string) {
   const row=sqlite.prepare(this.sql).get(...this.values as never[]);
   return row ? column ? row[column] : row : null;
  }
 }
 const DB = {
  prepare(sql:string) {return new Statement(sql);},
  async batch(statements:Statement[]) {
   sqlite.exec('BEGIN');
   try {const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}
   catch(error){sqlite.exec('ROLLBACK');throw error;}
  }
 } as unknown as D1Database;
 const env:Env={DB,JOBS:{send:vi.fn(async()=>{})} as unknown as Env['JOBS'],ALLOWED_GUILDS:'111,222'};
 return {env,sqlite,close:()=>sqlite.close()};
}
