import type { Env, Job, Notice, MealWeek, Schedule } from './types';
import { SOURCES, collectNotices, discoverMealSources, fetchImage } from './sources';
import {NOTICE_CHANNEL_COLUMNS,noticeChannelColumn} from './notice-channels';
import { formatMeal, formatMealPart, type MealPeriod } from './meals';
import { discordSend, allowedGuild, type DiscordMessageInput, type DiscordImageFile } from './discord';
import {batchNoticeCards,noticeCardMessage} from './notice-card';
import { addDays, todayKst, validDate } from './time';
import {boardHash,cleanupMealMessage,updateBoard} from './message-board';
import {mealCard} from './meal-card';
import { validateSchedules } from './schedule';
import { updateScheduleSummary } from './schedule-summary';
import { claim, deliveryIntent, deliveryIntentStatements, dispatch, enqueue, nowIso, recover, retryJob, saveNotices, sourceFailure } from './storage';
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
 let image:Awaited<ReturnType<typeof fetchImage>>;
 try{image=await fetchImage(source.imageUrl);}catch{return `${date} 공식 메뉴표 이미지 파일을 불러오지 못했습니다.\n원문: <${source.url}>`;}
 const window=mealWindow();
 if(source.start<window.start||source.end>window.end)return unavailableMeal(env,date);
 return {content:`${date} 식단 텍스트를 확인하지 못해 공식 주간 메뉴표를 이미지 파일로 첨부합니다 (${source.start} ~ ${source.end}).\n원문: <${source.url}>`,file:{filename:`bellarmino-${source.start}-${source.end}.${image.mime==='image/png'?'png':'jpg'}`,bytes:image.bytes,mime:image.mime}};
}
export type MealSlot='morning'|'evening';
function usableMeal(day:MealWeek['days'][number]|undefined,period:MealPeriod):boolean {
 return !!day&&(period==='dinner'?day.dinner.status!=='unknown':[day.breakfastKorean,day.breakfastWestern,day.breakfastCommon].some(offering=>offering.status!=='unknown'));
}
function reportExpiry(date:string,slot:MealSlot):string {
 return slot==='morning'?`${date}T08:30:00.000Z`:`${date}T15:00:00.000Z`;
}
export async function mealReportResponse(env:Env,date:string,slot:MealSlot,includeFiles=true,onImageFailure?:()=>void):Promise<DiscordMessageInput> {
 const targets:{date:string;period:MealPeriod;label:string}[]=slot==='morning'
  ?[{date,period:'breakfast',label:'오늘 아침'},{date,period:'dinner',label:'오늘 저녁'}]
  :[{date,period:'dinner',label:'오늘 저녁'},{date:addDays(date,1),period:'breakfast',label:'내일 아침'}];
 const parts:string[]=[],files:DiscordImageFile[]=[],downloaded=new Set<string>();let bytes=0;
 for(const target of targets){
  const cached=await retainedMeal(env,target.date),day=cached?.week.days.find(day=>day.date===target.date);
  const usable=usableMeal(day,target.period);
  const source=!usable?await mealImageSource(env,target.date):null;
  const url=cached?.sourceUrl??source?.url??'https://scc.sogang.ac.kr/front/cmsboardlist.do?bbsConfigFK=1185&siteId=dormitory';
  let part=formatMealPart(cached?.week??null,target.date,url,target.period,target.label);
  if(!usable&&source&&includeFiles){
   if(!downloaded.has(source.url)){
    downloaded.add(source.url);
    try{
     const image=await fetchImage(source.imageUrl),window=mealWindow();
     if(source.start>=window.start&&source.end<=window.end&&bytes+image.bytes.length<=5*1024*1024){
      files.push({filename:`bellarmino-${source.start}-${source.end}.${image.mime==='image/png'?'png':'jpg'}`,bytes:image.bytes,mime:image.mime});bytes+=image.bytes.length;
     }
    }catch{onImageFailure?.();/* Keep the exact dated section/link; no stale substitute or upstream details. */}
   }
   if(files.some(file=>file.filename.startsWith(`bellarmino-${source.start}-${source.end}.`)))part+='\n첨부: 해당 주 공식 메뉴표';
   else part+='\n이미지 첨부 불가 — 원문을 확인하세요.';
  }
  parts.push(part);
 }
 const content=parts.join('\n\n')+'\nOCR 판독 결과로 메뉴명에 오탈자가 있을 수 있습니다. 미확인 항목은 원문을 확인하세요.';
 return files.length?{content,files}:content;
}
function activeMealSlot(time=new Date()):MealSlot|null {
 const hhmm=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(time);
 return hhmm<'07:00'?null:hhmm<'17:30'?'morning':'evening';
}
export async function updateMealBoard(env:Env,guild:string,channel:string,allowCreate=false):Promise<void>{
 const date=todayKst(),slot=activeMealSlot();if(!slot)return;
 const preview=mealCard(await mealReportResponse(env,date,slot,false));
 const targets:[string,MealPeriod][]=slot==='morning'?[[date,'breakfast'],[date,'dinner']]:[[date,'dinner'],[addDays(date,1),'breakfast']],images=[];
 for(const [target,period] of targets){
  const cached=await retainedMeal(env,target),day=cached?.week.days.find(day=>day.date===target);
  if(usableMeal(day,period))continue;
  const source=await mealImageSource(env,target);
  if(source)images.push({url:source.url,imageUrl:source.imageUrl,start:source.start,end:source.end});
 }
 const hash=await boardHash({preview,images});let complete=true;
 await updateBoard(env,guild,channel,{table:'meal_messages',field:'meals_channel',date,key:`${date}:${slot==='morning'?0:1}`,hash,allowCreate,replace:true,
 valid:()=>activeMealSlot()===slot,complete:()=>complete,render:async()=>mealCard(await mealReportResponse(env,date,slot,true,()=>{complete=false;}))});
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
 await enqueue(env,`schedule-daily:${date}`,'schedule-daily',{date});
 }
 for(const [mealSlot,time] of [['morning','07:00'],['evening','17:30']] as const){
  if(mins(hhmm)>=mins(time)&&mins(hhmm)<mins(time)+15)await enqueue(env,`meal-report:${date}:${mealSlot}`,'meal-report',{date,mealSlot});
 }
 const quarter=Math.floor(scheduledTime/(15*60_000));
 await enqueue(env,`schedule-refresh:${quarter}`,'schedule-refresh',{date});
 if(activeMealSlot(new Date(scheduledTime)))await enqueue(env,`meal-refresh:${quarter}`,'meal-refresh',{date});
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
 const columns=Object.values(NOTICE_CHANNEL_COLUMNS);
 const guilds=await env.DB.prepare(`SELECT id,notices_channel,${columns.join(',')} FROM guilds`).all<{id:string;notices_channel:string|null}&Record<typeof columns[number],string|null>>();
 for(const g of guilds.results){
  if(!allowedGuild(g.id,env))continue;
  const prefix=`${job.id}:${g.id}:`;
  // A committed plan freezes destinations, including uncertain/legacy sends, across setup changes.
  const existing=await env.DB.prepare('SELECT COUNT(*) AS count FROM deliveries WHERE guild_id=? AND substr(id,1,?)=?').bind(g.id,prefix.length,prefix).first<{count:number}>();
  if(existing?.count){
   // Older versions committed chunks separately. Never silently complete a partial legacy plan,
   // or guess new destinations for its missing chunks after an operator changes setup.
   if(existing.count<batchNoticeCards(payload.notices as Notice[]).length)await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error='Incomplete existing notice delivery plan; operator review required' WHERE id=? AND state='running'").bind(job.id).run();
   continue;
  }
  const destinations=new Map<string,Notice[]>();
  for(const notice of payload.notices as Notice[]){
   const column=noticeChannelColumn(notice.source),channel=(column?g[column]:null)??g.notices_channel;
   if(!channel)continue;
   const notices=destinations.get(channel)??[];notices.push(notice);destinations.set(channel,notices);
  }
  const statements: D1PreparedStatement[]=[];let index=0;
  for(const [channel,notices] of destinations)for(const chunk of batchNoticeCards(notices)){
   statements.push(...deliveryIntentStatements(env,`${prefix}${index++}`,g.id,channel,chunk.content,new Date(Date.parse(job.created_at)+86400_000).toISOString(),undefined,undefined,chunk.noticeCard));
  }
  // All destinations commit together; a partial failure must not leave a half-frozen plan.
  if(statements.length)await env.DB.batch(statements);
 }
 break;
 }
 case 'meal-discover': {
 await pruneMealContent(env);
 const sources=await discoverMealSources();
 await cacheMealSources(env,sources);
 const info=sources.find(source=>source.start<=todayKst()&&source.end>=todayKst())??sources[0];
 if(!info)break;
 await env.DB.prepare("INSERT INTO health(id,last_attempt,last_success,source_url,error) VALUES('meal-discovery',?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt,last_success=excluded.last_success,source_url=excluded.source_url,error=NULL").bind(nowIso(),nowIso(),info.url).run();
 break;
 }
 case 'meal-extract': {
 // Retain legacy audit data; an old Queue message must never call a model.
 await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error=COALESCE(error,'Meal inference retired; use OCR') WHERE id=? AND state='running'").bind(job.id).run();
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
 case 'meal-report': {
 if(payload.date!==todayKst()||!['morning','evening'].includes(payload.mealSlot)||nowIso()>=reportExpiry(payload.date,payload.mealSlot))break;
 if(activeMealSlot()!==payload.mealSlot)break;
 const minute=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
 const start=payload.mealSlot==='morning'?'07:00':'17:30',end=payload.mealSlot==='morning'?'07:15':'17:45';
 for(const g of await recipients(env,'meals_channel'))await enqueue(env,`meal-board:${job.id}:${g.id}:${g.channel}`,'meal-board',{guild:g.id,channel:g.channel,date:payload.date,mealSlot:payload.mealSlot,allowCreate:minute>=start&&minute<end});
 break;
 }
 case 'meal-refresh': {
 if(payload.date!==todayKst())break;
 for(const g of await recipients(env,'meals_channel'))await enqueue(env,`meal-board:${job.id}:${g.id}:${g.channel}`,'meal-board',{guild:g.id,channel:g.channel,date:payload.date,allowCreate:false});
 break;
 }
 case 'meal-cleanup': {
 await cleanupMealMessage(env,payload);
 break;
 }
 case 'meal-board': {
 if(payload.date!==todayKst())break;
 const minute=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
 const window=payload.mealSlot==='morning'?minute>='07:00'&&minute<'07:15':payload.mealSlot==='evening'?minute>='17:30'&&minute<'17:45':false;
 await updateMealBoard(env,payload.guild,payload.channel,payload.allowCreate===true&&window&&activeMealSlot()===payload.mealSlot);
 break;
 }
 case 'meal-daily': {
 if(payload.date!==todayKst()) break;
 const content=await mealResponse(env,payload.date);
 for(const g of await recipients(env,'meals_channel')) await deliveryIntent(env,`meal:${g.id}:${payload.date}`,g.id,g.channel,content,new Date(`${payload.date}T15:00:00Z`).toISOString(),payload.date);
 break;
 }
 case 'schedule-refresh':
 case 'schedule-daily': {
 if(payload.date!==todayKst()) break;
 for(const g of await recipients(env,'schedule_channel')) await enqueue(env,`schedule-summary:${g.id}:${g.channel}:${payload.date}${job.kind==='schedule-daily'?'':`:${job.id}`}`,'schedule-summary',{guild:g.id,channel:g.channel,date:payload.date,allowCreate:job.kind==='schedule-daily'});
 break;
 }
 case 'schedule-summary': {
 if(payload.date!==todayKst())break;
 await updateScheduleSummary(env,payload.guild,payload.channel,payload.date,await getSchedules(env),payload.allowCreate!==false);
 break;
 }
 case 'deliver': {
 await env.DB.prepare("UPDATE deliveries SET state='expired',updated_at=? WHERE id=? AND state IN ('pending','retry') AND expires_at<=?").bind(nowIso(),payload.deliveryId,nowIso()).run();
 const row=await env.DB.prepare("UPDATE deliveries SET state='sending',updated_at=? WHERE id=? AND state IN ('pending','retry') RETURNING *").bind(nowIso(),payload.deliveryId).first<{guild_id:string;channel_id:string;content:string;expires_at:string}>();
 if(!row) break;
 if(!allowedGuild(row.guild_id,env)){await env.DB.prepare("UPDATE deliveries SET state='failed',error='guild disabled' WHERE id=?").bind(payload.deliveryId).run();break;}
 // Keep file bytes transient; the durable intent carries only the meal date/slot.
 const content=payload.mealDate&&payload.mealSlot?await mealReportResponse(env,payload.mealDate,payload.mealSlot):payload.mealDate?await mealCommandResponse(env,payload.mealDate):payload.noticeCard?noticeCardMessage(payload.noticeCard):row.content;
 if(row.expires_at<=nowIso()||(payload.mealDate&&payload.mealDate!==todayKst())){
 await env.DB.prepare("UPDATE deliveries SET state='expired',updated_at=? WHERE id=? AND state='sending'").bind(nowIso(),payload.deliveryId).run();break;
 }
 const result=await discordSend(env,row.channel_id,content);
 await env.DB.prepare('UPDATE deliveries SET state=?,message_id=?,updated_at=?,error=? WHERE id=?').bind(result.state,result.messageId??null,nowIso(),result.state==='sent'?null:result.state,payload.deliveryId).run();
 if(result.state==='retry') {const error=new Error('Discord rate limited') as Error&{retryAfter:number};error.retryAfter=result.retryAfter??60;throw error;}
 break;
 }
 default: throw new Error('unknown job');
 }
}
export async function consume(env:Env,batch:MessageBatch<{id:string}>) {
 for(const msg of batch.messages) {
 // Retire even delayed or exhausted legacy jobs before claiming/incrementing attempts.
 // Running leases and terminal outcomes are untouched; reservations and payloads remain exact.
 const retired=await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error=COALESCE(error,'Meal inference retired; use OCR') WHERE id=? AND kind='meal-extract' AND state IN ('pending','retry') RETURNING id").bind(msg.body.id).first();
 if(retired){msg.ack();continue;}
 const job=await claim(env,msg.body.id);
 if(!job){msg.ack();continue;}
 let snapshotRetry:number|undefined;
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
 if(job.kind==='interaction') {
 await retryJob(env,job,'interaction completion failed',5);
 } else if(job.kind==='meal-extract') {
 await env.DB.prepare("UPDATE jobs SET state='needs_review',lease_until=NULL,error=COALESCE(error,'Meal inference retired; use OCR') WHERE id=? AND state='running'").bind(job.id).run();
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
 if(snapshotRetry===undefined)msg.ack();else msg.retry({delaySeconds:snapshotRetry});
 }
 await dispatch(env);
}
