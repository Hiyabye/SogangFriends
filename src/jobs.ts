import type { Env, Job, Notice, MealWeek, Schedule } from './types';
import { SOURCES, collectNotices, discoverMealSources, fetchImage } from './sources';
import { extractMeal, formatMeal, MealExtractionError, MEAL_ATTEMPTS_PER_MODEL, MEAL_MAX_ATTEMPTS, MEAL_PRIMARY_MODEL, MEAL_FALLBACK_MODEL, mealRetryDelay } from './meals';
import { batchNotices, discordSend, allowedGuild, type DiscordMessageInput } from './discord';
import { todayKst, validDate } from './time';
import { dueReminders, validateSchedules } from './schedule';
import { claim, deliveryIntent, dispatch, enqueue, nowIso, recover, reserveLlm, retryJob, saveNotices, sourceFailure } from './storage';
import {cacheMealSources,mealImageSource,mealWindow,pruneMealContent} from './meal-cache';
export async function getSchedules(env:Env):Promise<Schedule[]> {
 const rows=await env.DB.prepare('SELECT data,active FROM schedules').all<{data:string;active:number}>();
 return validateSchedules(rows.results.map(r=>({...JSON.parse(r.data),active:r.active===1})));
}
async function retainedMeal(env:Env,date:string) {
 const window=mealWindow();
 const row=await env.DB.prepare('SELECT data,source_url FROM meals WHERE start_date<=? AND end_date>=? AND start_date>=? AND end_date<=? ORDER BY extracted_at DESC LIMIT 1').bind(date,date,window.start,window.end).first<{data:string;source_url:string}>();
 return row?{week:JSON.parse(row.data) as MealWeek,sourceUrl:row.source_url}:null;
}
async function unavailableMeal(env:Env,date:string) {
 const source=await env.DB.prepare("SELECT source_url FROM health WHERE id='meal-discovery'").first<{source_url:string|null}>();
 return `식단 확인 불가 (${date})\n${source?.source_url??'https://scc.sogang.ac.kr/front/cmsboardlist.do?bbsConfigFK=1185&siteId=dormitory'}`;
}
export async function mealResponse(env:Env,date:string) {
 if(!validDate(date))return '날짜를 YYYY-MM-DD 형식으로 입력하세요. 예: /meal date:2026-10-12';
 const cached=await retainedMeal(env,date);
 return cached?formatMeal(cached.week,date,cached.sourceUrl):unavailableMeal(env,date);
}
export async function mealCommandResponse(env:Env,date:string):Promise<DiscordMessageInput> {
 if(!validDate(date))return mealResponse(env,date);
 const cached=await retainedMeal(env,date),day=cached?.week.days.find(day=>day.date===date);
 const usable=day&&([day.breakfastKorean,day.breakfastWestern,day.dinner].some(offering=>offering.status!=='unknown')||day.cupRice.status==='available');
 if(cached&&usable)return formatMeal(cached.week,date,cached.sourceUrl);
 const source=await mealImageSource(env,date);
 if(!source)return cached?formatMeal(cached.week,date,cached.sourceUrl):unavailableMeal(env,date);
 return {content:`${date} 식단 텍스트를 확인하지 못해 공식 주간 메뉴표를 안내합니다.\n원문: <${source.url}>`,embeds:[{title:`벨라르미노 주간 메뉴 (${source.start} ~ ${source.end})`,url:source.url,image:{url:source.imageUrl}}]};
}
export async function planCron(env:Env,scheduledTime:number) {
 await pruneMealContent(env);
 await recover(env);
 const hours=Number(env.SOURCE_INTERVAL_HOURS??'6');
 const interval=(Number.isFinite(hours)&&hours>=1?hours:6)*3600_000;
 const slot=Math.floor(scheduledTime/interval);
 if(env.NOTICE_COLLECTION_MODE!=='external') for(const source of SOURCES) await enqueue(env,`collect:${source.id}:${slot}`,'collect',{source:source.id});
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
 case 'notice-snapshot': {
 if(Date.now()-Date.parse(job.created_at)>30*60_000)throw new Error('Notice snapshot expired');
 await saveNotices(env,payload.source,payload.notices,nowIso());
 break;
 }
 case 'collect': {
 if(env.NOTICE_COLLECTION_MODE==='external')break;
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
 await pruneMealContent(env);
 const sources=await discoverMealSources();
 await cacheMealSources(env,sources);
 const info=sources.find(source=>source.start<=todayKst()&&source.end>=todayKst())??sources[0];
 if(!info)break;
 await env.DB.prepare("INSERT INTO health(id,last_attempt,last_success,source_url,error) VALUES('meal-discovery',?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,last_success=excluded.last_success,source_url=excluded.source_url,error=NULL").bind(nowIso(),nowIso(),info.url).run();
 if(payload.sourceOnly===true||env.LLM_ENABLED!=='true'||!env.OPENROUTER_API_KEY)break;
 const image=await fetchImage(info.imageUrl);
 const version=env.PROCESSING_VERSION??'meal-v4-retry-free';
 const key=`${image.hash}:${version}:${info.start}:${info.end}:${info.url}`;
 const cached=await env.DB.prepare('SELECT cache_key FROM meals WHERE cache_key=?').bind(key).first();
 if(cached) await env.DB.prepare('UPDATE meals SET verified_at=? WHERE cache_key=?').bind(nowIso(),key).run();
 else if(env.LLM_ENABLED==='true'&&env.OPENROUTER_API_KEY) await enqueue(env,`extract:${key}`,'meal-extract',{...info,hash:image.hash,version,key,models:[env.MEAL_MODEL??MEAL_PRIMARY_MODEL,env.MEAL_FALLBACK_MODEL??MEAL_FALLBACK_MODEL]});
 break;
 }
 case 'meal-extract': {
 const window=mealWindow();
 if(payload.start<window.start||payload.end>window.end){
 await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error='Meal outside retained weeks; not inferred' WHERE id=?").bind(job.id).run();break;
 }
 let image:Awaited<ReturnType<typeof fetchImage>>;
 try{image=await fetchImage(payload.imageUrl);}catch{throw new MealExtractionError('Meal image preflight failed',null,true);}
 if(image.hash!==payload.hash) throw new MealExtractionError('Meal image changed; rediscovery required');
 // Only an explicitly operator-created verification job gets this extra-run allowance.
 const reservationEnv=payload.operatorExtraRun===true?{...env,LLM_DAILY_CALLS:'3',LLM_DAILY_BUDGET_USD:'0.75'}:env;
 let reserved:boolean;
 try{reserved=await reserveLlm(reservationEnv,job.id,todayKst());}catch{throw new MealExtractionError('Meal reservation preflight failed',null,true);}
 if(!reserved) {
 await env.DB.prepare("INSERT INTO health(id,last_attempt,error) VALUES('meal',?,'LLM disabled or budget blocked') ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(nowIso()).run();
 // A blocked job can be explicitly retried by operator, not on every queue redelivery.
 throw new MealExtractionError('LLM disabled or budget blocked');
 }
 const models=payload.models??[env.MEAL_MODEL??MEAL_PRIMARY_MODEL,env.MEAL_FALLBACK_MODEL??MEAL_FALLBACK_MODEL];
 const model=models[job.attempts<=MEAL_ATTEMPTS_PER_MODEL?0:1];
 const result=await extractMeal({...env,MEAL_MODEL:model},image,{start:payload.start,end:payload.end,published:payload.published},{allowPromptOnlyJson:payload.promptOnlyJsonModel===model,...(payload.disableReasoning===true?{disableReasoning:true}:{})});
 const at=nowIso(),currentWindow=mealWindow();
 if(payload.start<currentWindow.start||payload.end>currentWindow.end){
 await env.DB.batch([
 env.DB.prepare("UPDATE llm_usage SET actual_usd=CASE WHEN ? IS NULL THEN actual_usd ELSE COALESCE(actual_usd,0)+? END,state='completed' WHERE id=?").bind(result.actualCost,result.actualCost,job.id),
 env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error='Meal completed after retention window; result not cached' WHERE id=?").bind(job.id)
 ]);
 break;
 }
 await env.DB.batch([
 env.DB.prepare('INSERT OR IGNORE INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(payload.key,payload.url,image.hash,payload.version,payload.start,payload.end,JSON.stringify(result.week),at,at,result.model),
 env.DB.prepare("UPDATE llm_usage SET actual_usd=CASE WHEN ? IS NULL THEN actual_usd ELSE COALESCE(actual_usd,0)+? END,state='completed' WHERE id=?").bind(result.actualCost,result.actualCost,job.id),
 env.DB.prepare("INSERT INTO health(id,last_attempt,last_success,error) VALUES('meal',?,?,NULL) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,last_success=excluded.last_success,error=NULL").bind(at,at)]);
 break;
 }
 case 'meal-quarantine': {
 const key=payload.cacheKey;
 if(typeof key!=='string'||!key)throw new Error('Invalid meal quarantine identity');
 const owner=`extract:${key}`,at=nowIso(),reason='Meal failed source-image comparison; result quarantined';
 // Keep the exact rejected result before removing it from the serving cache. The
 // delete requires matching audit proof; one batch rolls all three changes back.
 await env.DB.batch([
 env.DB.prepare("UPDATE jobs SET payload=json_set(payload,'$.rejectedExtraction',json((SELECT json_object('cacheKey',cache_key,'data',json(data),'model',model,'sourceUrl',source_url,'imageHash',image_hash,'version',version,'startDate',start_date,'endDate',end_date,'extractedAt',extracted_at,'verifiedAt',verified_at,'reviewedAt',?,'reason',?) FROM meals WHERE cache_key=?))),state='needs_review',lease_until=NULL,error=? WHERE id=? AND kind='meal-extract' AND state='done' AND json_extract(payload,'$.key')=? AND json_type(payload,'$.rejectedExtraction') IS NULL AND EXISTS(SELECT 1 FROM meals WHERE cache_key=?)").bind(at,reason,key,reason,owner,key,key),
 env.DB.prepare("DELETE FROM meals WHERE cache_key=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND kind='meal-extract' AND state='needs_review' AND json_extract(payload,'$.rejectedExtraction.cacheKey')=meals.cache_key AND json_extract(payload,'$.rejectedExtraction.data')=json(meals.data))").bind(key,owner),
 env.DB.prepare("INSERT INTO health(id,last_attempt,error) SELECT 'meal',?,? FROM jobs WHERE id=? AND kind='meal-extract' AND state='needs_review' AND json_extract(payload,'$.rejectedExtraction.cacheKey')=? AND NOT EXISTS(SELECT 1 FROM meals WHERE cache_key=?) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(at,reason,owner,key,key)
 ]);
 const committed=await env.DB.prepare("SELECT id FROM jobs WHERE id=? AND kind='meal-extract' AND state='needs_review' AND json_extract(payload,'$.rejectedExtraction.cacheKey')=? AND NOT EXISTS(SELECT 1 FROM meals WHERE cache_key=?)").bind(owner,key,key).first();
 if(!committed)throw new Error('Meal quarantine not committed');
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
 for(const {item,offset,kind,date} of dueReminders(await getSchedules(env),payload.date)) {
 const label=offset===0?'당일':`D-${offset}`;
 const phase=kind==='start'?'시작':item.type!=='deadline'&&item.startDate===date?'시작·마감':'마감';
 const when=kind==='deadline'?(item.deadlineAt??date):item.endDate?`${date} ~ ${item.endDate}`:date;
 const caution=kind==='deadline'?(item.deadlineAt?'':' (날짜만 공지됨; 마감 시각 확인 필요)'):' (날짜 기준; 세부 운영 시각은 원문 확인)';
 const text=`[학사 일정 ${phase} ${label}] ${item.title}\n${when}${caution}${item.note?`\n${item.note}`:''}\n${item.sourceUrl}`;
 // Preserve existing deadline keys; start reminders have a separate identity.
 const suffix=kind==='deadline'?String(offset):`start:${offset}`;
 for(const g of await recipients(env,'schedule_channel')) await deliveryIntent(env,`schedule:${g.id}:${item.id}:${suffix}`,g.id,g.channel,text,new Date(`${payload.date}T15:00:00Z`).toISOString());
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
 if(!job){
 // An early redelivery can follow an uncertain delayed-producer send. Keep its durable wait alive.
 const waiting=await env.DB.prepare("SELECT available_at FROM jobs WHERE id=? AND kind='meal-extract' AND state='retry' AND attempts<? AND available_at>?").bind(msg.body.id,MEAL_MAX_ATTEMPTS,nowIso()).first<{available_at:string}>();
 if(waiting)await env.JOBS.send({id:msg.body.id},{delaySeconds:Math.min(86400,Math.max(1,Math.ceil((Date.parse(waiting.available_at)-Date.now())/1000)))});
 msg.ack();continue;
 }
 let snapshotRetry:number|undefined;
 let mealRetry:number|undefined;
 try {
 if(job.kind==='interaction') {const {completeInteraction}=await import('./worker');await completeInteraction(env,job);}
 else await executeJob(env,job);
 await env.DB.prepare("UPDATE jobs SET state='done',lease_until=NULL,error=NULL WHERE id=? AND state='running'").bind(job.id).run();
 } catch(error) {
 // These jobs contain only public source data; never log interaction tokens or model requests.
 if(job.kind==='collect'||job.kind==='notice-snapshot'||job.kind==='meal-discover') console.error('Source job failed',job.kind,error);
 const sourceError=(job.kind==='collect'||job.kind==='notice-snapshot'||job.kind==='meal-discover')?(error instanceof Error?error.message.slice(0,300):'source job failed'):null;
 if(job.kind==='collect'||job.kind==='notice-snapshot') await env.DB.prepare('UPDATE sources SET error=? WHERE id=?').bind(sourceError,JSON.parse(job.payload).source).run();
 if(job.kind==='meal-discover') await env.DB.prepare("INSERT INTO health(id,last_attempt,error) VALUES('meal-discovery',?,?) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(nowIso(),sourceError).run();
 // No automatic billable replay or webhook replay after ambiguous outcomes.
 if(job.kind==='meal-extract' && error instanceof MealExtractionError && error.actualCost!==null) await env.DB.prepare("UPDATE llm_usage SET actual_usd=COALESCE(actual_usd,0)+?,state='rejected' WHERE id=?").bind(error.actualCost,job.id).run();
 if(job.kind==='meal-extract' && error instanceof MealExtractionError && error.safeRetry) {
 await env.DB.prepare("UPDATE llm_usage SET state='safe_retry' WHERE id=?").bind(job.id).run();
 const verificationOnly=JSON.parse(job.payload).verificationOnly===true;
 const phase=job.attempts<=MEAL_ATTEMPTS_PER_MODEL?'primary':'fallback';
 const reason=job.attempts>=MEAL_MAX_ATTEMPTS?`Meal 5+5 attempts exhausted; operator model choice required: ${error.message}`:`OpenRouter ${phase} attempt ${(job.attempts-1)%MEAL_ATTEMPTS_PER_MODEL+1}/${MEAL_ATTEMPTS_PER_MODEL}: ${error.message}`;
 const delay=mealRetryDelay(job.attempts,error.retryAfter);
 if(verificationOnly)await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error=? WHERE id=?").bind(`One-off meal verification rejected: ${error.message}`,job.id).run();
 else await retryJob(env,job,reason,delay);
 await env.DB.prepare("INSERT INTO health(id,last_attempt,error) VALUES('meal',?,?) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(nowIso(),verificationOnly?`One-off verification rejected: ${error.message}`:reason).run();
 if(!verificationOnly&&job.attempts<MEAL_MAX_ATTEMPTS)mealRetry=delay;
 } else if(job.kind==='interaction') {
 await retryJob(env,job,'interaction completion failed',5);
 } else if(job.kind==='meal-extract') {
 const reason=error instanceof MealExtractionError?error.message:'meal extraction blocked/failed; inspect source and budget';
 await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error=? WHERE id=?").bind(reason,job.id).run();
 await env.DB.prepare("INSERT INTO health(id,last_attempt,error) VALUES('meal',?,?) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error").bind(nowIso(),reason).run();
 } else if(job.kind==='notice-snapshot'&&Date.now()-Date.parse(job.created_at)>30*60_000) {
 await env.DB.prepare("UPDATE jobs SET state='failed',lease_until=NULL,error='Notice snapshot expired' WHERE id=?").bind(job.id).run();
 } else {
 const delay=(error as {retryAfter?:number})?.retryAfter??Math.min(3600,60*2**job.attempts);
 await retryJob(env,job,sourceError??'job failed',delay);
 // Caught snapshot failures schedule their own retry rather than waiting for Cron.
 if(job.kind==='notice-snapshot'&&job.attempts<3)snapshotRetry=Math.min(86400,Math.max(1,Math.ceil(delay)));
 }
 }
 // Tokens persist only while waiting; clear after any terminal interaction attempt.
 if(job.kind==='interaction') await env.DB.prepare("UPDATE jobs SET payload='{}' WHERE id=? AND state IN ('done','failed','needs_review')").bind(job.id).run();
 // Fresh messages reset Queue delivery retries; D1 still enforces the ten-attempt model ceiling.
 if(mealRetry!==undefined)await env.JOBS.send({id:job.id},{delaySeconds:Math.min(86400,mealRetry)});
 if(snapshotRetry===undefined)msg.ack();else msg.retry({delaySeconds:snapshotRetry});
 }
 await dispatch(env);
}
