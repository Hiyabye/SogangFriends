import type { Env, Job, Notice } from './types';
export const nowIso = () => new Date().toISOString();
export async function enqueue(env:Env,id:string,kind:string,payload:unknown) {
 await env.DB.prepare('INSERT OR IGNORE INTO jobs(id,kind,payload,created_at,available_at) VALUES(?,?,?,?,?)').bind(id,kind,JSON.stringify(payload),nowIso(),nowIso()).run();
}
export async function dispatch(env:Env) {
 const rows=await env.DB.prepare("SELECT id FROM jobs WHERE state IN ('pending','retry') AND available_at<=? ORDER BY created_at LIMIT 40").bind(nowIso()).all<{id:string}>();
 for (const row of rows.results) await env.JOBS.send({id:row.id});
}
export async function claim(env:Env,id:string):Promise<Job|null> {
 return env.DB.prepare("UPDATE jobs SET state='running',attempts=attempts+1,lease_until=? WHERE id=? AND state IN ('pending','retry') AND available_at<=? AND attempts<3 RETURNING *").bind(new Date(Date.now()+20*60_000).toISOString(),id,nowIso()).first<Job>();
}
export async function retryJob(env:Env,job:Job,error:string,delay=60) {
 await env.DB.prepare('UPDATE jobs SET state=?,error=?,available_at=?,lease_until=NULL WHERE id=? AND state=\'running\'').bind(job.attempts>=3?'failed':'retry',error,new Date(Date.now()+Math.min(86400,Math.max(1,delay))*1000).toISOString(),job.id).run();
}
export async function recover(env:Env) {
 // A crashed delivery may already exist at Discord. Never replay a POST blindly.
 await env.DB.batch([
 env.DB.prepare("UPDATE deliveries SET state='uncertain',error='send interrupted; manual reconciliation required',updated_at=? WHERE state='sending' AND updated_at<?").bind(nowIso(),new Date(Date.now()-15*60_000).toISOString()),
 env.DB.prepare("UPDATE jobs SET state=CASE WHEN kind IN ('deliver','interaction','meal-extract') THEN 'needs_review' WHEN attempts>=3 THEN 'failed' ELSE 'retry' END,error='lease expired',lease_until=NULL WHERE state='running' AND lease_until<?").bind(nowIso()),
 env.DB.prepare("UPDATE jobs SET payload='{}',state='needs_review',error='interaction expired' WHERE kind='interaction' AND (state IN ('done','failed','needs_review') OR created_at<?)").bind(new Date(Date.now()-15*60_000).toISOString())]);
}
export function freshNotices(existing:Set<string>,rows:Notice[],initialized:boolean) {return initialized?rows.filter(n=>!existing.has(n.id)):[];}
export async function saveNotices(env:Env,source:string,rows:Notice[],at:string) {
 const owner=crypto.randomUUID();
 await env.DB.prepare('INSERT OR IGNORE INTO sources(id) VALUES(?)').bind(source).run();
 const acquired=await env.DB.prepare('UPDATE sources SET lease_owner=?,lease_until=? WHERE id=? AND (lease_owner IS NULL OR lease_until<?) RETURNING id').bind(owner,new Date(Date.now()+15*60_000).toISOString(),source,nowIso()).first();
 if(!acquired) throw new Error('source snapshot busy');
 try {
 const previous=await env.DB.prepare('SELECT initialized FROM sources WHERE id=?').bind(source).first<{initialized:number}>();
 const old=await env.DB.prepare('SELECT id FROM notices WHERE source=?').bind(source).all<{id:string}>();
 const fresh=freshNotices(new Set(old.results.map(r=>r.id)),rows,previous?.initialized===1);
 // Durable snapshot and notification job are committed together; queue dispatch may be retried.
 const statements=rows.map(n=>env.DB.prepare('INSERT INTO notices(source,id,title,published,url,collected_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET title=excluded.title,published=excluded.published,url=excluded.url,collected_at=excluded.collected_at').bind(source,n.id,n.title,n.published,n.url,at));
 statements.push(env.DB.prepare('INSERT INTO sources(id,initialized,last_success,last_attempt,error) VALUES(?,1,?,?,NULL) ON CONFLICT(id) DO UPDATE SET initialized=1,last_success=excluded.last_success,last_attempt=excluded.last_attempt,error=NULL').bind(source,at,at));
 if(fresh.length) statements.push(env.DB.prepare('INSERT OR IGNORE INTO jobs(id,kind,payload,created_at,available_at) VALUES(?,?,?,?,?)').bind(`notice-alert:${source}:${at}`,'notice-alert',JSON.stringify({notices:fresh}),at,at));
 await env.DB.batch(statements);
 } finally { await env.DB.prepare('UPDATE sources SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?').bind(source,owner).run(); }
}
export async function sourceFailure(env:Env,source:string) {
 await env.DB.prepare("INSERT INTO sources(id,last_attempt,error) VALUES(?,?,'source collection failed') ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(source,nowIso()).run();
}
export async function deliveryIntent(env:Env,id:string,guild:string,channel:string,content:string,expiresAt=new Date(Date.now()+86400_000).toISOString()) {
 const at=nowIso();
 await env.DB.batch([
 env.DB.prepare('INSERT OR IGNORE INTO deliveries(id,guild_id,channel_id,content,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(id,guild,channel,content,at,at,expiresAt),
 env.DB.prepare('INSERT OR IGNORE INTO jobs(id,kind,payload,created_at,available_at) VALUES(?,?,?,?,?)').bind(`send:${id}`,'deliver',JSON.stringify({deliveryId:id}),at,at)]);
}
export async function reserveLlm(env:Env,id:string,day:string):Promise<boolean> {
 if(env.LLM_ENABLED!=='true'||!env.OPENROUTER_API_KEY) return false;
 const cap=Number(env.LLM_DAILY_BUDGET_USD??'0.50'); const calls=Number(env.LLM_DAILY_CALLS??'2'); const per=Number(env.LLM_MAX_CALL_USD??'0.25');
 if(!Number.isFinite(cap)||!Number.isFinite(per)||!Number.isInteger(calls)||cap<=0||per<=0||calls<=0) return false;
 const existing=await env.DB.prepare('SELECT state,reserved_usd FROM llm_usage WHERE id=? AND day=?').bind(id,day).first<{state:string;reserved_usd:number}>();
 if(existing?.state==='safe_retry' && existing.reserved_usd>=per) {
 const reused=await env.DB.prepare("UPDATE llm_usage SET state='reserved' WHERE id=? AND state='safe_retry' RETURNING id").bind(id).first();
 return !!reused;
 }
 // Unknown/failed usage retains its reservation. SQL serializes concurrent reservations.
 const r=await env.DB.prepare("INSERT OR IGNORE INTO llm_usage(id,day,reserved_usd,state,created_at) SELECT ?,?,?,'reserved',? WHERE (SELECT COUNT(*) FROM llm_usage WHERE day=?)<? AND (SELECT COALESCE(SUM(MAX(reserved_usd,COALESCE(actual_usd,0))),0) FROM llm_usage WHERE day=?) + ? <= ?").bind(id,day,per,nowIso(),day,calls,day,per,cap).run();
 return r.meta.changes===1;
}
