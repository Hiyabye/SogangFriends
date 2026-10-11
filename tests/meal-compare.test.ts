import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {handleRequest} from '../src/worker';
import {testDatabase} from './helpers/db';

const secret='comparison-test-secret-with-more-than32-characters';
const id='actions-meal-compare:'+ 'a'.repeat(32),runId='38099999999';
const pinned=()=>({model:'dots-studio/dots-3-note-preview:free',expected:{start:'2026-10-05',end:'2026-10-11',published:'2026-09-30'},imageUrl:'https://scc.sogang.ac.kr/dataview/board/1185/20260930_1516_3210001.jpg',sourceUrl:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941444',imageHash:'b'.repeat(64),maxAttempts:2,expiresAt:new Date(Date.now()+30*60_000).toISOString()});
let db:ReturnType<typeof testDatabase>;
function seed(){
 const at=new Date().toISOString();
 db.sqlite.prepare('INSERT INTO jobs(id,kind,payload,state,created_at,available_at) VALUES(?,?,?,?,?,?)').run(id,'meal-actions-compare',JSON.stringify(pinned()),'comparison_ready',at,at);
 db.sqlite.prepare('INSERT INTO llm_usage(id,day,reserved_usd,state,created_at) VALUES(?,?,?,?,?)').run(id,'2026-10-11',.25,'reserved',at);
}
async function send(value:unknown,{timestamp=String(Date.now()),signature}: {timestamp?:string;signature?:string}={}){
 const body=JSON.stringify(value);
 const signed=signature??createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
 return handleRequest(new Request('https://worker.test/internal/meal-compare',{method:'POST',headers:{'content-type':'application/json','x-collector-timestamp':timestamp,'x-collector-signature':signed},body}),db.env);
}
const claim=()=>send({action:'claim',id,runId});
const report=(extra:Record<string,unknown>={})=>send({action:'report',id,runId,state:'completed',actualCost:0,attempts:1,...extra});
const job=()=>db.sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(id)!;
const usage=()=>db.sqlite.prepare('SELECT * FROM llm_usage WHERE id=?').get(id)!;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-11T02:00:00Z'));db=testDatabase();db.env.NOTICE_INGEST_SECRET=secret;db.env.LLM_ENABLED='true';seed();});
afterEach(()=>{db.close();vi.useRealTimers();vi.restoreAllMocks();});

describe('operator-preallocated Actions meal comparison',()=>{
 it('respects the inference pause for claims without blocking outcome reporting',async()=>{
  db.env.LLM_ENABLED='false';expect((await claim()).status).toBe(409);
  db.env.LLM_ENABLED='true';expect((await claim()).status).toBe(200);
  db.env.LLM_ENABLED='false';expect((await report()).status).toBe(200);
 });
 it('returns only pinned configuration and elects one concurrent claimant',async()=>{
  const results=await Promise.all([claim(),claim()]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  expect(await results.find(r=>r.status===200)!.json()).toEqual({id,runId,...pinned()});
  expect(job().state).toBe('comparison_running');expect(JSON.parse(String(job().payload)).githubRunId).toBe(runId);
  expect(usage().state).toBe('reserved');expect(usage().reserved_usd).toBe(.25);expect(db.env.JOBS.send).not.toHaveBeenCalled();
  expect((await claim()).status).toBe(409);
 });
 it('rejects invalid/stale HMAC and disabled secrets without changing the ticket',async()=>{
  expect((await send({action:'claim',id,runId},{signature:'0'.repeat(64)})).status).toBe(401);
  expect((await send({action:'claim',id,runId},{timestamp:String(Date.now()-5*60_000-1)})).status).toBe(401);
  db.env.NOTICE_INGEST_SECRET='short';expect((await claim()).status).toBe(503);expect(job().state).toBe('comparison_ready');
 });
 it('enforces the8KiB authenticated body limit and disallows raw output fields',async()=>{
  expect((await send({action:'claim',id,runId,raw:'x'.repeat(9000)})).status).toBe(413);
  expect((await report({week:{days:[]}})).status).toBe(400);expect(job().state).toBe('comparison_ready');
 });
 it('cannot create a ticket or reservation and cannot claim a released reservation',async()=>{
  expect((await send({action:'claim',id:'actions-meal-compare:'+'c'.repeat(32),runId})).status).toBe(409);
  db.sqlite.prepare('DELETE FROM llm_usage WHERE id=?').run(id);expect((await claim()).status).toBe(409);
  expect(db.sqlite.prepare('SELECT COUNT(*) n FROM llm_usage').get()!.n).toBe(0);
  db.sqlite.prepare('INSERT INTO llm_usage(id,day,reserved_usd,state,created_at) VALUES(?,?,?,?,?)').run(id,'2026-10-11',0,'confirmed_rejected',new Date().toISOString());
  expect((await claim()).status).toBe(409);expect(job().state).toBe('comparison_ready');
 });
 it('rejects expired tickets before inference authorization',async()=>{
  vi.advanceTimersByTime(30*60_000);expect((await claim()).status).toBe(409);expect(job().state).toBe('comparison_ready');expect(usage().state).toBe('reserved');
 });
 it('rejects malformed configurations, non-Dots models and noncanonical upstream URLs',async()=>{
  for(const change of [{model:'paid/model'},{model:'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'},{maxAttempts:3},{imageHash:'bad'},{imageUrl:'https://evil.test/image.jpg'},{imageUrl:'https://scc.sogang.ac.kr/dataview/board/1185/image.jpg?token=private'},{sourceUrl:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=other&pkid=941444'},{expected:{start:'2026-10-06',end:'2026-10-12',published:'2026-09-30'}},{expiresAt:'not-a-date'},{expected:null}]){
   db.sqlite.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify({...pinned(),...change}),id);
   expect((await claim()).status).toBe(409);expect(job().state).toBe('comparison_ready');
  }
 });
 it('refuses a wrong job kind or a pre-used ticket even when its state was reset',async()=>{
  db.sqlite.prepare("UPDATE jobs SET kind='meal-extract' WHERE id=?").run(id);expect((await claim()).status).toBe(409);
  db.sqlite.prepare("UPDATE jobs SET kind='meal-actions-compare',payload=? WHERE id=?").run(JSON.stringify({...pinned(),githubRunId:runId}),id);expect((await claim()).status).toBe(409);
 });
 it('rejects reports before claim, from another runner, or exceeding the two-attempt limit',async()=>{
  expect((await report()).status).toBe(409);await claim();expect((await report({runId:'123'})).status).toBe(409);
  for(const attempts of [0,3,1.5,'2'])expect((await report({attempts})).status).toBe(400);
  for(const actualCost of [-1,'0'])expect((await report({actualCost})).status).toBe(400);
  expect((await report({state:'confirmed_rejected'})).status).toBe(400);expect(usage().state).toBe('reserved');
 });
 it('records a complete whole-run report exactly once without creating meals or deliveries',async()=>{
  await claim();const before=usage();expect((await report({actualCost:.012,attempts:2})).status).toBe(200);
  expect(usage()).toMatchObject({state:'completed',actual_usd:.012,reserved_usd:before.reserved_usd,day:before.day,created_at:before.created_at});
  const saved=job();expect(saved.state).toBe('comparison_done');expect(saved.attempts).toBe(2);
  expect(JSON.parse(String(saved.payload)).report).toEqual({runId,state:'completed',actualCost:.012,attempts:2});
  expect((await report({actualCost:.012,attempts:2})).status).toBe(200);expect(job()).toEqual(saved);expect(usage().actual_usd).toBe(.012);
  expect((await report({actualCost:0,attempts:2})).status).toBe(409);
  for(const table of ['meals','deliveries','notice_archive_raw'])expect(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n).toBe(0);
  expect(db.env.JOBS.send).not.toHaveBeenCalled();
 });
 it('accepts identical concurrent reports without accumulating their cost twice',async()=>{
  await claim();const responses=await Promise.all([report({actualCost:.012,attempts:2}),report({actualCost:.012,attempts:2})]);
  expect(responses.map(r=>r.status)).toEqual([200,200]);expect(usage().actual_usd).toBe(.012);expect(job().state).toBe('comparison_done');
 });
 it('preserves uncertain reservations and existing observed cost, including after expiry',async()=>{
  await claim();db.sqlite.prepare('UPDATE llm_usage SET actual_usd=.005 WHERE id=?').run(id);vi.advanceTimersByTime(31*60_000);
  expect((await report({state:'reserved',actualCost:null,attempts:2})).status).toBe(200);
  expect(usage()).toMatchObject({state:'reserved',actual_usd:.005,reserved_usd:.25});expect(job().state).toBe('needs_review');
  const saved=job();expect((await report({state:'reserved',actualCost:null,attempts:2})).status).toBe(200);expect(job()).toEqual(saved);
 });
 it('records exhausted safe failures without releasing the reservation',async()=>{
  await claim();expect((await report({state:'safe_retry',actualCost:0,attempts:2})).status).toBe(200);
  expect(usage()).toMatchObject({state:'safe_retry',actual_usd:0,reserved_usd:.25});expect(job().state).toBe('comparison_done');expect((await claim()).status).toBe(409);
 });
 it('does not finish a report when its reservation is missing or already terminal',async()=>{
  await claim();db.sqlite.prepare("UPDATE llm_usage SET state='completed' WHERE id=?").run(id);
  expect((await report()).status).toBe(409);expect(job().state).toBe('comparison_running');
  db.sqlite.prepare('DELETE FROM llm_usage WHERE id=?').run(id);expect((await report()).status).toBe(409);expect(job().state).toBe('comparison_running');
 });
 it('rolls back both report writes if the job finalization fails and returns a fixed error',async()=>{
  await claim();db.sqlite.exec("CREATE TRIGGER reject_comparison_report BEFORE UPDATE ON jobs WHEN NEW.state='comparison_done' BEGIN SELECT RAISE(ABORT,'private-db-error'); END;");
  const response=await report({actualCost:.012});expect(response.status).toBe(503);expect(await response.text()).toBe('Comparison unavailable');
  expect(usage()).toMatchObject({state:'reserved',actual_usd:null,reserved_usd:.25});expect(job().state).toBe('comparison_running');expect(JSON.parse(String(job().payload))).not.toHaveProperty('report');
 });
});
