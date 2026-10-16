import type {Env} from './types.ts';
import {allowedGuild} from './discord.ts';
import {dispatch,nowIso} from './storage.ts';
import {todayKst} from './time.ts';
import {fetchLibrarySnapshot,LIBRARY_URL,type LibrarySnapshot} from './library-source.ts';

export const LIBRARY_CRON='* 0-11 * * *'; // 09:00–20:59 KST; ordinary Cron is unchanged.
const GAP_MS=180_000,FRESH_MS=120_000;
interface Watch {channel_id:string;day:string;remaining:number;source_at:string;observed_at:string;revision:string;event_id:string|null}
export function libraryWindow(time=Date.now()):boolean {
 const hour=new Date(time+9*3600_000).getUTCHours();return hour>=9&&hour<21;
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
  // Repeated or out-of-order upstream observations never keep an old snapshot fresh.
  if(sameRoute&&previous&&previous.source_at>=snapshot.sourceAt)break;
  const baseline=!previous||!sameRoute||previous.day!==day||now-Date.parse(previous.observed_at)>=GAP_MS||source-Date.parse(previous.source_at)>=GAP_MS;
  const opening=!baseline&&previous!.remaining===0&&snapshot.remaining>0;
  const revision=crypto.randomUUID(),event=opening?`library:${guild.id}:${revision}`:baseline||snapshot.remaining===0?null:previous!.event_id;
  const content=`133 로욜라 인벤툼 II 잔여 좌석이 생겼습니다.\n잔여 ${snapshot.remaining}석 / 전체 ${snapshot.total}석\n확인 시각: ${snapshot.sourceAt.slice(0,10)} ${new Date(source+9*3600_000).toISOString().slice(11,19)} KST\n좌석 배정 현황 기준이며, 도착 시 이용 가능 여부는 달라질 수 있습니다. 장애인 좌석이 포함될 수 있습니다.\n<${LIBRARY_URL}>`;
  const expires=new Date(Math.min(source+FRESH_MS,now+FRESH_MS,Date.parse(`${day}T12:00:00.000Z`))).toISOString();
  const statements=[env.DB.prepare(`INSERT INTO library_watches(guild_id,channel_id,day,remaining,source_at,observed_at,revision,event_id)
   SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM guilds WHERE id=? AND library_channel=?)
   ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,day=excluded.day,remaining=excluded.remaining,source_at=excluded.source_at,observed_at=excluded.observed_at,revision=excluded.revision,event_id=excluded.event_id
   WHERE library_watches.revision=?`).bind(guild.id,guild.channel,day,snapshot.remaining,snapshot.sourceAt,at,revision,event,guild.id,guild.channel,previous?.revision??null)];
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
 return !!row&&row.day===todayKst()&&row.remaining>0&&now-Date.parse(row.source_at)<=FRESH_MS&&now-Date.parse(row.observed_at)<=FRESH_MS;
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
