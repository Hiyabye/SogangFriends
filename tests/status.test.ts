import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {operationalStatus} from '../src/status';
import {enqueue} from '../src/storage';
import type {DiscordMessageInput} from '../src/discord';
let db:ReturnType<typeof testDatabase>;
beforeEach(()=>{db=testDatabase();});
afterEach(()=>{db.close();vi.unstubAllGlobals();});
const full=(result:DiscordMessageInput)=>typeof result==='string'?result:result.file?new TextDecoder().decode(result.file.bytes):result.content;
async function failed(id:string,kind='meal-extract',state='failed') {
 await enqueue(db.env,id,kind,{});db.sqlite.prepare('UPDATE jobs SET state=?,attempts=3,error=? WHERE id=?').run(state,'fixed public diagnostic',id);
}
function review(id:string,disposition='closed') {
 db.sqlite.prepare('INSERT INTO job_reviews(job_id,job_state,attempts,disposition,reason,reviewed_at) SELECT id,state,attempts,?,?,? FROM jobs WHERE id=?').run(disposition,'Operator reviewed history','2026-10-11T00:00:00Z',id);
}
describe('operational status and audit dispositions',()=>{
 it('keeps closed failures in history, deferred and new failures visible, and reservations unchanged',async()=>{
  await failed('old','collect');await failed('uncertain','meal-extract','needs_review');await failed('new','meal-extract');
  review('old');review('uncertain','deferred');
  db.sqlite.prepare("INSERT INTO llm_usage(id,day,reserved_usd,state,created_at) VALUES('uncertain','2026-10-11',0.25,'reserved','now')").run();
  const before=db.sqlite.prepare('SELECT * FROM jobs ORDER BY id').all(),usage=db.sqlite.prepare('SELECT * FROM llm_usage').all();
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const text=full(await operationalStatus(db.env,'111'));
  const issues=JSON.parse(text.split('공유 미해결·보류: ')[1].split('\n')[0]);
  expect(issues).toHaveLength(2);expect(issues.every((row:{kind:string})=>row.kind==='meal-extract')).toBe(true);
  expect(text).toContain('"review":"closed"');expect(text).toContain('"review":"deferred"');
  expect(db.sqlite.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(before);expect(db.sqlite.prepare('SELECT * FROM llm_usage').all()).toEqual(usage);expect(fetch).not.toHaveBeenCalled();
 });
 it('reopens a reviewed issue if state or attempt count changes',async()=>{
  await failed('old','collect');review('old');
  expect(full(await operationalStatus(db.env,'111'))).toContain('공유 미해결·보류: []');
  db.sqlite.prepare('UPDATE jobs SET attempts=4 WHERE id=?').run('old');
  expect(full(await operationalStatus(db.env,'111'))).toContain('"review":"unreviewed"');
  db.sqlite.prepare("UPDATE jobs SET attempts=3,state='needs_review' WHERE id=?").run('old');
  expect(full(await operationalStatus(db.env,'111'))).toContain('"review":"unreviewed"');
 });
 it('shows only the current guild/channel summary and never another guild command details',async()=>{
  db.sqlite.exec("INSERT INTO guilds(id,schedule_channel,updated_at) VALUES('111','1001','now'),('222','2002','now'); INSERT INTO schedule_messages(guild_id,channel_id,message_id,state,updated_at) VALUES('111','1001','9001','ready','now'),('111','1002','9002','uncertain','now'),('222','2002','9003','uncertain','now');");
  await enqueue(db.env,'other','interaction',{interaction:{guild_id:'222',token:'secret-token'}});db.sqlite.prepare("UPDATE jobs SET state='failed' WHERE id='other'").run();
  const text=full(await operationalStatus(db.env,'111'));
  expect(text).toContain('9001');for(const hidden of ['9002','9003','2002','secret-token'])expect(text).not.toContain(hidden);
 });
 it('shows only this guild institution channels in both normal and attachment responses',async()=>{
  const first=['1559799050054799433','1559799078798495805','1559799123903909908','1559799151942959115','1559799178136264754','1560465047128514640','1560644512672649309','1560644541982445680'];
  db.sqlite.prepare('INSERT INTO guilds(id,university_channel,computing_channel,swedu_channel,convedu_channel,bdata_channel,engineering_channel,psychology_channel,business_channel,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('111',...first,'now');
  db.sqlite.prepare('INSERT INTO guilds(id,university_channel,computing_channel,swedu_channel,convedu_channel,bdata_channel,engineering_channel,psychology_channel,business_channel,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('222','other-university','other-computing','other-swedu','other-convedu','other-bdata','other-engineering','other-psychology','other-business','now');
  for(const forceAttachment of [false,true]){
   if(forceAttachment)for(let i=0;i<40;i++)await failed(`settings-job-${i}`,`settings-kind-${i}`);
   const result=await operationalStatus(db.env,'111'),text=full(result);
   for(const id of first)expect(text).toContain(id);
   expect(text).not.toContain('other-');
   if(forceAttachment){
    expect(typeof result).toBe('object');
    if(typeof result!=='string'){
     expect(result.content.length).toBeLessThanOrEqual(2000);
     for(const id of first)expect(result.content).toContain(id);
     expect(result.content).not.toContain('other-');
    }
   }
  }
 });
 it('attaches full diagnostics instead of silently truncating long status output',async()=>{
  for(let i=0;i<40;i++)await failed(`job-${i}`,`fixture-kind-${i}`);
  const result=await operationalStatus(db.env,'111');expect(typeof result).toBe('object');
  if(typeof result==='string')throw new Error('Expected full status file');
  expect(result.file?.filename).toMatch(/^status-.*\.txt$/);expect(full(result)).toContain('fixture-kind-39');
  // The visible overview must also fit Discord's message limit.
  expect(result.content.length).toBeLessThanOrEqual(2000);
 });
});
