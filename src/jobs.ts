import type { Env, Job, Notice, MealWeek, Schedule } from './types';
import { SOURCES, collectNotices, discoverMeal, fetchImage } from './sources';
import { extractMeal, formatMeal, MealExtractionError } from './meals';
import { batchNotices, discordSend, allowedGuild } from './discord';
import { todayKst } from './time';
import { dueReminders, validateSchedules } from './schedule';
import { claim, deliveryIntent, dispatch, enqueue, nowIso, recover, reserveLlm, retryJob, saveNotices, sourceFailure } from './storage';
export async function getSchedules(env:Env):Promise<Schedule[]> {
 const rows=await env.DB.prepare('SELECT data,active FROM schedules').all<{data:string;active:number}>();
 return validateSchedules(rows.results.map(r=>({...JSON.parse(r.data),active:r.active===1})));
}
export async function mealResponse(env:Env,date:string) {
 const row=await env.DB.prepare('SELECT data,source_url FROM meals WHERE start_date<=? AND end_date>=? ORDER BY extracted_at DESC LIMIT 1').bind(date,date).first<{data:string;source_url:string}>();
 if(row) return formatMeal(JSON.parse(row.data) as MealWeek,date,row.source_url);
 const source=await env.DB.prepare("SELECT source_url FROM health WHERE id='meal-discovery'").first<{source_url:string|null}>();
 return `식단 확인 불가 (${date})\n${source?.source_url??'https://scc.sogang.ac.kr/front/cmsboardlist.do?bbsConfigFK=1185&siteId=dormitory'}`;
}
export async function planCron(env:Env,scheduledTime:number) {
 await recover(env);
 const hours=Number(env.SOURCE_INTERVAL_HOURS??'6');
 const interval=(Number.isFinite(hours)&&hours>=1?hours:6)*3600_000;
 const slot=Math.floor(scheduledTime/interval);
 for(const source of SOURCES) await enqueue(env,`collect:${source.id}:${slot}`,'collect',{source:source.id});
 await enqueue(env,`meal-discover:${slot}`,'meal-discover',{});
 const date=todayKst(new Date(scheduledTime));
 const hhmm=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(scheduledTime));
 const target=/^([01]\d|2[0-3]):[0-5]\d$/.test(env.MEAL_TIME_KST??'')?env.MEAL_TIME_KST!:'07:30';
 // Only the current quarter-hour window; no replay of missed daily broadcasts after downtime.
 const mins=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3));
 if(mins(hhmm)>=mins(target)&&mins(hhmm)<mins(target)+15) {
 await enqueue(env,`meal-daily:${date}`,'meal-daily',{date});
 await enqueue(env,`schedule-daily:${date}`,'schedule-daily',{date});
 }
 await dispatch(env);
}
async function recipients(env:Env,field:'notices_channel'|'meals_channel'|'schedule_channel') {
 const rows=await env.DB.prepare(`SELECT id,${field} AS channel FROM guilds WHERE ${field} IS NOT NULL`).all<{id:string;channel:string}>();
 return rows.results.filter(r=>allowedGuild(r.id,env));
}
export async function executeJob(env:Env,job:Job) {
 const payload=JSON.parse(job.payload);
 switch(job.kind) {
 case 'collect': {
 const source=SOURCES.find(s=>s.id===payload.source); if(!source) throw new Error('unknown source');
 try {const rows=await collectNotices(source);await saveNotices(env,source.id,rows,nowIso());}
 catch(error) {await sourceFailure(env,source.id);throw error;} break;
 }
 case 'notice-alert': {
 // Avoid catch-up floods from jobs older than a day. Still retain notices for queries.
 if(Date.now()-Date.parse(job.created_at)>86400_000) break;
 const notices=(payload.notices as Notice[]).map(n=>({...n,source:SOURCES.find(s=>s.id===n.source)?.name??n.source}));
 const chunks=batchNotices(notices);
 for(const g of await recipients(env,'notices_channel')) for(let i=0;i<chunks.length;i++) await deliveryIntent(env,`${job.id}:${g.id}:${i}`,g.id,g.channel,chunks[i],new Date(Date.parse(job.created_at)+86400_000).toISOString());
 break;
 }
 case 'meal-discover': {
 const info=await discoverMeal();
 await env.DB.prepare("INSERT INTO health(id,last_attempt,last_success,source_url,error) VALUES('meal-discovery',?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,last_success=excluded.last_success,source_url=excluded.source_url,error=NULL").bind(nowIso(),nowIso(),info.url).run();
 const image=await fetchImage(info.imageUrl);
 const version=env.PROCESSING_VERSION??'meal-v1';
 const key=`${image.hash}:${version}:${info.start}:${info.end}:${info.url}`;
 const cached=await env.DB.prepare('SELECT cache_key FROM meals WHERE cache_key=?').bind(key).first();
 if(cached) await env.DB.prepare('UPDATE meals SET verified_at=? WHERE cache_key=?').bind(nowIso(),key).run();
 else await enqueue(env,`extract:${key}`,'meal-extract',{...info,hash:image.hash,version,key});
 break;
 }
 case 'meal-extract': {
 const image=await fetchImage(payload.imageUrl);
 if(image.hash!==payload.hash) throw new Error('image changed; rediscovery required');
 if(!await reserveLlm(env,job.id,todayKst())) {
 await env.DB.prepare("INSERT INTO health(id,last_attempt,error) VALUES('meal',?,'LLM disabled or budget blocked') ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(nowIso()).run();
 // A blocked job can be explicitly retried by operator, not on every queue redelivery.
 throw new Error('LLM blocked');
 }
 const result=await extractMeal(env,image,{start:payload.start,end:payload.end,published:payload.published});
 const at=nowIso();
 await env.DB.batch([
 env.DB.prepare('INSERT OR IGNORE INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(payload.key,payload.url,image.hash,payload.version,payload.start,payload.end,JSON.stringify(result.week),at,at,result.model),
 env.DB.prepare("UPDATE llm_usage SET actual_usd=?,state='completed' WHERE id=?").bind(result.actualCost,job.id),
 env.DB.prepare("INSERT INTO health(id,last_attempt,last_success,error) VALUES('meal',?,?,NULL) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,last_success=excluded.last_success,error=NULL").bind(at,at)]);
 break;
 }
 case 'meal-daily': {
 if(payload.date!==todayKst()) break;
 const content=await mealResponse(env,payload.date);
 for(const g of await recipients(env,'meals_channel')) await deliveryIntent(env,`meal:${g.id}:${payload.date}`,g.id,g.channel,content,new Date(`${payload.date}T15:00:00Z`).toISOString());
 break;
 }
 case 'schedule-daily': {
 if(payload.date!==todayKst()) break;
 for(const {item,offset} of dueReminders(await getSchedules(env),payload.date)) {
 const label=offset===0?'당일':`D-${offset}`;
 const text=`[학사 일정 ${label}] ${item.title}\n${item.deadlineAt??item.deadlineDate} ${item.deadlineAt?'':'(날짜만 공지됨; 마감 시각 확인 필요)'}\n${item.sourceUrl}`;
 for(const g of await recipients(env,'schedule_channel')) await deliveryIntent(env,`schedule:${g.id}:${item.id}:${offset}`,g.id,g.channel,text,new Date(`${payload.date}T15:00:00Z`).toISOString());
 }
 break;
 }
 case 'deliver': {
 await env.DB.prepare("UPDATE deliveries SET state='expired',updated_at=? WHERE id=? AND state IN ('pending','retry') AND expires_at<=?").bind(nowIso(),payload.deliveryId,nowIso()).run();
 const row=await env.DB.prepare("UPDATE deliveries SET state='sending',updated_at=? WHERE id=? AND state IN ('pending','retry') RETURNING *").bind(nowIso(),payload.deliveryId).first<{guild_id:string;channel_id:string;content:string}>();
 if(!row) break;
 if(!allowedGuild(row.guild_id,env)){await env.DB.prepare("UPDATE deliveries SET state='failed',error='guild disabled' WHERE id=?").bind(payload.deliveryId).run();break;}
 const result=await discordSend(env,row.channel_id,row.content);
 await env.DB.prepare('UPDATE deliveries SET state=?,message_id=?,updated_at=?,error=? WHERE id=?').bind(result.state,result.messageId??null,nowIso(),result.state==='sent'?null:result.state,payload.deliveryId).run();
 if(result.state==='retry') {const error=new Error('Discord rate limited') as Error&{retryAfter:number};error.retryAfter=result.retryAfter??60;throw error;}
 break;
 }
 default: throw new Error('unknown job');
 }
}
export async function consume(env:Env,batch:MessageBatch<{id:string}>) {
 for(const msg of batch.messages) {
 const job=await claim(env,msg.body.id);
 if(!job){msg.ack();continue;}
 try {
 if(job.kind==='interaction') {const {completeInteraction}=await import('./worker');await completeInteraction(env,job);}
 else await executeJob(env,job);
 await env.DB.prepare("UPDATE jobs SET state='done',lease_until=NULL,error=NULL WHERE id=? AND state='running'").bind(job.id).run();
 } catch(error) {
 if(job.kind==='meal-discover') await env.DB.prepare("INSERT INTO health(id,last_attempt,error) VALUES('meal-discovery',?,'meal source collection failed') ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(nowIso()).run();
 // No automatic billable replay or webhook replay after ambiguous outcomes.
 if(job.kind==='meal-extract' && error instanceof MealExtractionError && error.actualCost!==null) await env.DB.prepare("UPDATE llm_usage SET actual_usd=?,state='rejected' WHERE id=?").bind(error.actualCost,job.id).run();
 if(job.kind==='meal-extract' && error instanceof MealExtractionError && error.safeRetry) {
 await env.DB.prepare("UPDATE llm_usage SET state='safe_retry' WHERE id=? AND actual_usd IS NULL").bind(job.id).run();
 await retryJob(env,job,'OpenRouter confirmed rejection/preflight failure',error.retryAfter??60);
 } else if(job.kind==='interaction') {
 await retryJob(env,job,'interaction completion failed',5);
 } else if(job.kind==='meal-extract') {
 await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error=? WHERE id=?").bind(job.kind==='meal-extract'?'meal extraction blocked/failed; inspect source and budget':'interaction failed',job.id).run();
 if(job.kind==='meal-extract') await env.DB.prepare("INSERT INTO health(id,last_attempt,error) VALUES('meal',?,'extraction blocked/failed') ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(nowIso()).run();
 } else await retryJob(env,job,'job failed',(error as {retryAfter?:number})?.retryAfter??Math.min(3600,60*2**job.attempts));
 }
 // Tokens persist only while waiting; clear after any terminal interaction attempt.
 if(job.kind==='interaction') await env.DB.prepare("UPDATE jobs SET payload='{}' WHERE id=? AND state IN ('done','failed','needs_review')").bind(job.id).run();
 msg.ack();
 }
 await dispatch(env);
}
