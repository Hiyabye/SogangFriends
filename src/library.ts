import type {Env} from './types.ts';
import {allowedGuild} from './discord.ts';
import {dispatch,nowIso} from './storage.ts';
import {todayKst} from './time.ts';
import {fetchLibrarySnapshot,LIBRARY_URL,type LibrarySnapshot} from './library-source.ts';

export const LIBRARY_CRON='* 1-12 * * *'; // 10:00–21:59 KST; ordinary Cron is unchanged.
export const LIBRARY_SEAT_POLICY='room5-exclude-1-3-44-85-101-102-v1';
const GAP_MS=180_000,FRESH_MS=120_000;
interface Watch {channel_id:string;day:string;remaining:number;source_at:string;observed_at:string;revision:string;event_id:string|null;seat_policy:string|null}
export function libraryWindow(time=Date.now()):boolean {
 const hour=new Date(time+9*3600_000).getUTCHours();return hour>=10&&hour<22;
}
async function recipients(env:Env) {
 const rows=await env.DB.prepare('SELECT id,library_channel AS channel FROM guilds WHERE library_channel IS NOT NULL').all<{id:string;channel:string}>();
 return rows.results.filter(row=>allowedGuild(row.id,env));
}

export async function saveLibrarySnapshot(env:Env,snapshot:LibrarySnapshot,at=nowIso()):Promise<void> {
 const now=Date.parse(at),source=Date.parse(snapshot.sourceAt);
 if(!libraryWindow(now)||!Number.isFinite(source)||source>now+30_000||now-source>FRESH_MS)throw new Error('Library snapshot outside freshness window');
 const day=todayKst(new Date(now));
 for(const guild of await recipients(env)){
  for(let attempt=0;attempt<3;attempt++){
  const previous=await env.DB.prepare('SELECT * FROM library_watches WHERE guild_id=?').bind(guild.id).first<Watch>();
  const sameRoute=previous?.channel_id===guild.channel;
  const samePolicy=previous?.seat_policy===LIBRARY_SEAT_POLICY;
  // Repeated or out-of-order upstream observations never keep an old snapshot fresh.
  if(sameRoute&&samePolicy&&previous&&previous.source_at>=snapshot.sourceAt)break;
  const baseline=!previous||!sameRoute||!samePolicy||previous.day!==day||now-Date.parse(previous.observed_at)>=GAP_MS||source-Date.parse(previous.source_at)>=GAP_MS;
  const opening=!baseline&&previous!.remaining===0&&snapshot.remaining>0;
  const revision=crypto.randomUUID(),event=opening?`library:${guild.id}:${revision}`:baseline||snapshot.remaining===0?null:previous!.event_id;
  const content=`133 로욜라 인벤툼 II 잔여 좌석이 생겼습니다.\n알림 대상 ${snapshot.total}석 중 잔여 ${snapshot.remaining}석\n확인 시각: ${snapshot.sourceAt.slice(0,10)} ${new Date(source+9*3600_000).toISOString().slice(11,19)} KST\n좌석 배정 현황 기준이며, 도착 시 이용 가능 여부는 달라질 수 있습니다. 장애인석 1·3·44·85번과 리클라이너석 101·102번은 제외했습니다.\n<${LIBRARY_URL}>`;
  const expires=new Date(Math.min(source+FRESH_MS,now+FRESH_MS,Date.parse(`${day}T13:00:00.000Z`))).toISOString();
  const statements=[env.DB.prepare(`INSERT INTO library_watches(guild_id,channel_id,day,remaining,source_at,observed_at,revision,event_id,seat_policy)
   SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM guilds WHERE id=? AND library_channel=?)
   ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,day=excluded.day,remaining=excluded.remaining,source_at=excluded.source_at,observed_at=excluded.observed_at,revision=excluded.revision,event_id=excluded.event_id,seat_policy=excluded.seat_policy
   WHERE library_watches.revision=?`).bind(guild.id,guild.channel,day,snapshot.remaining,snapshot.sourceAt,at,revision,event,LIBRARY_SEAT_POLICY,guild.id,guild.channel,previous?.revision??null)];
  if(opening){
   // CAS proof and outbox commit together: neither a lost alert nor a competing writer's alert.
   statements.push(env.DB.prepare(`INSERT INTO deliveries(id,guild_id,channel_id,content,created_at,updated_at,expires_at)
    SELECT ?,?,?,?,?,?,? FROM library_watches WHERE guild_id=? AND revision=? AND event_id=?`).bind(event,guild.id,guild.channel,content,at,at,expires,guild.id,revision,event));
   statements.push(env.DB.prepare(`INSERT INTO jobs(id,kind,payload,created_at,available_at)
    SELECT ?,'deliver',?,?,? FROM library_watches WHERE guild_id=? AND revision=? AND event_id=?`).bind(`send:${event}`,JSON.stringify({deliveryId:event,libraryEvent:event}),at,at,guild.id,revision,event));
  }
  const results=await env.DB.batch(statements);
  if(results[0].meta.changes>0)break;
  // A competing snapshot/configuration won. Re-read rather than dropping a newer observation.
  if(attempt===2)throw new Error('Library observation contention');
  }
 }
}

export async function libraryDeliveryCurrent(env:Env,guild:string,channel:string,event:unknown):Promise<boolean> {
 const now=Date.now();if(typeof event!=='string'||!libraryWindow(now))return false;
 const row=await env.DB.prepare(`SELECT w.* FROM library_watches w JOIN guilds g ON g.id=w.guild_id AND g.library_channel=w.channel_id
  WHERE w.guild_id=? AND w.channel_id=? AND w.event_id=?`).bind(guild,channel,event).first<Watch>();
 return !!row&&row.seat_policy===LIBRARY_SEAT_POLICY&&row.day===todayKst()&&row.remaining>0&&now-Date.parse(row.source_at)<=FRESH_MS&&now-Date.parse(row.observed_at)<=FRESH_MS;
}

/** Commit confirmed POST tracking and cleanup intent together, before any DELETE. */
export async function recordLibraryMessage(env:Env,guild:string,channel:string,messageId:string,deliveryId:string):Promise<void> {
 if(![guild,channel,messageId].every(value=>/^\d+$/.test(value))||!deliveryId.startsWith(`library:${guild}:`))throw new Error('Invalid library delivery identity');
 const at=nowIso();
 // Gate every statement on the still-sending delivery. Repeated completion cannot adopt an
 // older message after a subsequent alert has already replaced it.
 const results=await env.DB.batch([
  env.DB.prepare(`INSERT OR IGNORE INTO jobs(id,kind,payload,created_at,available_at)
   SELECT 'library-cleanup:'||m.guild_id||':'||m.channel_id||':'||m.message_id,'library-cleanup',
    json_object('guild',m.guild_id,'channel',m.channel_id,'messageId',m.message_id,'replacementId',?),?,?
   FROM library_messages m JOIN deliveries d ON d.guild_id=m.guild_id AND d.channel_id=m.channel_id
   WHERE d.id=? AND d.guild_id=? AND d.channel_id=? AND d.state='sending' AND m.message_id!=?`)
   .bind(messageId,at,at,deliveryId,guild,channel,messageId),
  env.DB.prepare(`INSERT INTO library_messages(guild_id,channel_id,message_id,updated_at)
   SELECT guild_id,channel_id,?,? FROM deliveries WHERE id=? AND guild_id=? AND channel_id=? AND state='sending'
   ON CONFLICT(guild_id,channel_id) DO UPDATE SET message_id=excluded.message_id,updated_at=excluded.updated_at`)
   .bind(messageId,at,deliveryId,guild,channel),
  env.DB.prepare("UPDATE deliveries SET state='sent',message_id=?,updated_at=?,error=NULL WHERE id=? AND guild_id=? AND channel_id=? AND state='sending'")
   .bind(messageId,at,deliveryId,guild,channel),
 ]);
 if(results[2].meta.changes===0){
  const confirmed=await env.DB.prepare("SELECT id FROM deliveries WHERE id=? AND guild_id=? AND channel_id=? AND state='sent' AND message_id=?")
   .bind(deliveryId,guild,channel,messageId).first();
  if(!confirmed)throw new Error('Library completion has no sending delivery');
 }
}

/** Durable post-success cleanup only; a DELETE failure never creates another POST. */
export async function cleanupLibraryMessage(env:Env,payload:{guild:string;channel:string;messageId:string;replacementId:string}):Promise<void> {
 const {guild,channel,messageId,replacementId}=payload;
 if(![guild,channel,messageId,replacementId].every(value=>typeof value==='string'&&/^\d+$/.test(value))||messageId===replacementId)throw new Error('Invalid library cleanup identity');
 if(!allowedGuild(guild,env))return;
 const current=await env.DB.prepare('SELECT message_id FROM library_messages WHERE guild_id=? AND channel_id=?').bind(guild,channel).first<{message_id:string}>();
 if(!current||current.message_id===messageId)throw new Error('Library cleanup has no replacement tracking');
 // A later replacement is fine, but the replacement that authorized this deletion must
 // still have confirmed send proof. Never treat an uncertain POST as deletion permission.
 const replacement=await env.DB.prepare("SELECT id FROM deliveries WHERE id LIKE 'library:%' AND guild_id=? AND channel_id=? AND state='sent' AND message_id=?")
  .bind(guild,channel,replacementId).first();
 if(!replacement)throw new Error('Library cleanup has no confirmed replacement');
 if(!env.DISCORD_TOKEN)throw new Error('Library cleanup token unavailable');
 const response=await fetch(`https://discord.com/api/v10/channels/${channel}/messages/${messageId}`,{method:'DELETE',headers:{Authorization:`Bot ${env.DISCORD_TOKEN}`},signal:AbortSignal.timeout(15000)});
 if(response.ok)return;
 if(response.status===404){try{if((await response.json() as {code?:unknown}).code===10008)return;}catch{/* Only exact Unknown Message is deletion proof. */}}
 if(response.status===429){
  let seconds=60;
  try{const data=await response.json() as {retry_after?:unknown};if(typeof data.retry_after==='number'&&Number.isFinite(data.retry_after))seconds=Math.min(86400,Math.max(1,Math.ceil(data.retry_after)));}catch{/* Retry with the default cooldown. */}
  throw Object.assign(new Error('Library cleanup rate limited'),{retryAfter:seconds});
 }
 throw new Error('Library cleanup failed');
}

/** A single bounded read per tick, shared by all guilds. No per-minute job-history rows. */
export async function pollLibrary(env:Env,scheduledTime:number):Promise<void> {
 if(!libraryWindow()||!libraryWindow(scheduledTime)||Math.abs(Date.now()-scheduledTime)>60_000||!(await recipients(env)).length)return;
 const at=nowIso();
 await env.DB.prepare("INSERT INTO health(id,last_attempt) VALUES('library',?) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt").bind(at).run();
 try{
  const snapshot=await fetchLibrarySnapshot();
  await saveLibrarySnapshot(env,snapshot);
  await env.DB.prepare("UPDATE health SET last_success=?,error=NULL WHERE id='library'").bind(nowIso()).run();
 }catch{
  await env.DB.prepare("UPDATE health SET error='Library collection failed; last-good observation preserved' WHERE id='library'").run();
  // The next minute is a new observation, never a replay of this failed poll.
  return;
 }
 await dispatch(env);
}
