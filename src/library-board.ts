import type {Env} from './types.ts';
import {allowedGuild,discordSend,message} from './discord.ts';
import {nowIso} from './storage.ts';
import {addDays,todayKst} from './time.ts';
import {LIBRARY_URL} from './library-source.ts';
import {LIBRARY_SEAT_POLICY,libraryWindow,recordLibraryMessage} from './library.ts';

const LEASE_MS=120_000,FRESH_MS=120_000;
interface Watch {channel_id:string;day:string;remaining:number;source_at:string;observed_at:string;event_id:string|null;seat_policy:string|null}
interface Writer {lease_owner:string;post_state:string|null;retry_at:string|null;display_key:string|null}
interface Projection {watch:Watch|null;key:string;content:string;closed:boolean}
export class LibraryBoardRetry extends Error {
 readonly retryAfter:number;
 constructor(seconds=60){super('Library board write deferred');this.retryAfter=seconds;}
}
async function configured(env:Env,guild:string,channel:string){
 return allowedGuild(guild,env)&&(await env.DB.prepare('SELECT library_channel FROM guilds WHERE id=?').bind(guild).first<{library_channel:string|null}>())?.library_channel===channel;
}
async function acquire(env:Env,guild:string,channel:string):Promise<Writer|null>{
 const at=nowIso(),owner=crypto.randomUUID();
 await env.DB.prepare('INSERT OR IGNORE INTO library_board_state(guild_id,channel_id,updated_at) VALUES(?,?,?)').bind(guild,channel,at).run();
 // A crashed POST cannot be made safe merely by expiring its writer lease.
 await env.DB.prepare("UPDATE library_board_state SET post_state='uncertain',lease_owner=NULL,lease_until=NULL,error='Library POST interrupted; manual reconciliation required',updated_at=? WHERE guild_id=? AND channel_id=? AND operation='post' AND post_state='creating' AND lease_until<=?").bind(at,guild,channel,at).run();
 return env.DB.prepare("UPDATE library_board_state SET lease_owner=?,lease_until=?,operation='patch',updated_at=? WHERE guild_id=? AND channel_id=? AND (lease_owner IS NULL OR lease_until<=?) AND (retry_at IS NULL OR retry_at<=?) RETURNING *")
  .bind(owner,new Date(Date.now()+LEASE_MS).toISOString(),at,guild,channel,at,at).first<Writer>();
}
async function release(env:Env,guild:string,channel:string,owner:string,error:string|null=null,seconds=0,key:string|null=null){
 await env.DB.prepare('UPDATE library_board_state SET lease_owner=NULL,lease_until=NULL,operation=NULL,error=?,retry_at=?,display_key=COALESCE(?,display_key),updated_at=? WHERE guild_id=? AND channel_id=? AND lease_owner=?')
  .bind(error,seconds?new Date(Date.now()+seconds*1000).toISOString():null,key,nowIso(),guild,channel,owner).run();
}
async function owned(env:Env,guild:string,channel:string,owner:string){
 return !!await env.DB.prepare('SELECT guild_id FROM library_board_state WHERE guild_id=? AND channel_id=? AND lease_owner=? AND lease_until>?').bind(guild,channel,owner,nowIso()).first();
}
function sourceTime(at:string){return new Date(Date.parse(at)+9*3600_000).toISOString().replace('T',' ').slice(0,19)+' KST';}
async function projection(env:Env,guild:string,channel:string):Promise<Projection|null>{
 if(!await configured(env,guild,channel))return null;
 const now=Date.now(),closed=!libraryWindow(now);
 const watch=await env.DB.prepare('SELECT * FROM library_watches WHERE guild_id=? AND channel_id=? AND seat_policy=?').bind(guild,channel,LIBRARY_SEAT_POLICY).first<Watch>();
 if(!closed&&(!watch||watch.day!==todayKst()||now-Date.parse(watch.source_at)>FRESH_MS||now-Date.parse(watch.observed_at)>FRESH_MS||Date.parse(watch.source_at)>now+30_000))return null;
 const closedDay=new Date(now+9*3600_000).getUTCHours()<10?addDays(todayKst(),-1):todayKst();
 const key=closed?`closed:${closedDay}:${watch?.source_at??'none'}`:`open:${watch!.day}:${watch!.source_at}:${watch!.remaining}`;
 const count=watch?`${closed?'마지막 확인: ':''}알림 대상 96석 중 잔여 ${watch.remaining}석\n확인 시각: ${sourceTime(watch.source_at)}`:'마지막으로 확인한 좌석 정보가 없습니다.';
 const content=`133 로욜라 인벤툼 II 좌석 현황\n${closed?'좌석 확인 종료\n':''}${count}\n운영 시간: 매일 10:00–22:00 KST\n${closed?'22:00–다음 날 10:00에는 좌석 현황을 갱신하지 않습니다.\n':''}좌석 배정 현황 기준이며, 도착 시 이용 가능 여부는 달라질 수 있습니다. 장애인석 1·3·44·85번과 리클라이너석 101·102번은 제외했습니다.\n<${LIBRARY_URL}>`;
 return {watch,key,content,closed};
}
async function blockedPost(env:Env,guild:string,channel:string){
 return !!await env.DB.prepare("SELECT guild_id FROM library_board_state WHERE guild_id=? AND channel_id=? AND post_state='uncertain' UNION ALL SELECT guild_id FROM deliveries WHERE guild_id=? AND channel_id=? AND id LIKE 'library:%' AND state IN ('sending','uncertain') LIMIT 1").bind(guild,channel,guild,channel).first();
}
async function post(env:Env,guild:string,channel:string,writer:Writer,p:Projection,id:string,silent:boolean,expiresAt:string){
 const at=nowIso();
 const expire=async()=>{
  // No HTTP started: expire only our own preparation, never another writer's send.
  await env.DB.prepare("UPDATE deliveries SET state='expired',updated_at=? WHERE id=? AND state IN ('pending','retry','sending') AND EXISTS(SELECT 1 FROM library_board_state WHERE guild_id=? AND channel_id=? AND lease_owner=?)").bind(nowIso(),id,guild,channel,writer.lease_owner).run();
  await env.DB.prepare('UPDATE library_board_state SET post_state=NULL WHERE guild_id=? AND channel_id=? AND lease_owner=?').bind(guild,channel,writer.lease_owner).run();
  await release(env,guild,channel,writer.lease_owner);
 };
 const prepared=await env.DB.batch([
  env.DB.prepare("INSERT OR IGNORE INTO deliveries(id,guild_id,channel_id,content,state,created_at,updated_at,expires_at) VALUES(?,?,?,?,'pending',?,?,?)").bind(id,guild,channel,p.content,at,at,expiresAt),
  env.DB.prepare("UPDATE library_board_state SET operation='post',post_state='creating',post_delivery_id=? WHERE guild_id=? AND channel_id=? AND lease_owner=? AND EXISTS(SELECT 1 FROM deliveries WHERE id=? AND state IN ('pending','retry') AND expires_at>?)").bind(id,guild,channel,writer.lease_owner,id,at),
  env.DB.prepare("UPDATE deliveries SET state='sending',updated_at=? WHERE id=? AND state IN ('pending','retry') AND expires_at>? AND EXISTS(SELECT 1 FROM library_board_state WHERE guild_id=? AND channel_id=? AND lease_owner=?)").bind(at,id,at,guild,channel,writer.lease_owner),
 ]);
 if(!prepared[2].meta.changes){
  if(expiresAt<=nowIso())await expire();else await release(env,guild,channel,writer.lease_owner);
  return;
 }
 const current=await projection(env,guild,channel);
 const stillOwned=await owned(env,guild,channel,writer.lease_owner);
 // A newer positive watch may keep the event alive, but cannot extend its original TTL.
 if(!current||current.closed||!stillOwned||(!silent&&current.watch?.event_id!==id)||expiresAt<=nowIso()||!libraryWindow()){
  await expire();return;
 }
 const input={content:current.content,suppressNotifications:silent};
 const result=await discordSend(env,channel,input);
 if(result.state==='sent'){
  try{await recordLibraryMessage(env,guild,channel,result.messageId!,id,{owner:writer.lease_owner,key:current.key});}
  catch(error){
   await env.DB.prepare("UPDATE library_board_state SET post_state='uncertain',lease_owner=NULL,lease_until=NULL,error='Library POST tracking failed; manual reconciliation required' WHERE guild_id=? AND channel_id=? AND lease_owner=?").bind(guild,channel,writer.lease_owner).run();throw error;
  }
  return;
 }
 await env.DB.prepare('UPDATE deliveries SET state=?,error=?,updated_at=? WHERE id=? AND state=\'sending\'').bind(result.state,result.state,nowIso(),id).run();
 await env.DB.prepare('UPDATE library_board_state SET post_state=? WHERE guild_id=? AND channel_id=? AND lease_owner=?').bind(result.state==='uncertain'?'uncertain':null,guild,channel,writer.lease_owner).run();
 const seconds=result.state==='retry'?result.retryAfter??60:result.state==='failed'?900:0;
 await release(env,guild,channel,writer.lease_owner,result.state==='uncertain'?'Library POST uncertain; manual reconciliation required':`Library POST ${result.state}`,seconds);
 if(result.state==='retry')throw new LibraryBoardRetry(seconds);
}
async function patch(env:Env,guild:string,channel:string,id:string,content:string):Promise<'sent'|'missing'>{
 if(!env.DISCORD_TOKEN)throw new LibraryBoardRetry(900);
 let response:Response;
 try{response=await fetch(`https://discord.com/api/v10/channels/${channel}/messages/${id}`,{method:'PATCH',headers:{Authorization:`Bot ${env.DISCORD_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({...message(content),embeds:[],attachments:[]}),signal:AbortSignal.timeout(15000)});}
 catch{throw new LibraryBoardRetry();}
 if(response.ok)return 'sent';
 if(response.status===404){try{if((await response.json() as {code?:unknown}).code===10008)return 'missing';}catch{/* Only exact Unknown Message permits recreation. */}}
 if(response.status===429){let seconds=60;try{const body=await response.json() as {retry_after?:unknown};if(typeof body.retry_after==='number'&&Number.isFinite(body.retry_after))seconds=Math.min(86400,Math.max(1,Math.ceil(body.retry_after)));}catch{/* Default bounded cooldown. */}throw new LibraryBoardRetry(seconds);}
 throw new LibraryBoardRetry(response.status>=500||response.status===408?60:900);
}
/** One current-state reconciliation, not a durable per-minute job or historical retry. */
export async function updateLibraryBoard(env:Env,guild:string,channel:string,closedOnly=false):Promise<void>{
 if(!await configured(env,guild,channel))return;
 const writer=await acquire(env,guild,channel);if(!writer)return;
 try{
  let p=await projection(env,guild,channel);
  if(!p||(closedOnly&&!p.closed)){await release(env,guild,channel,writer.lease_owner);return;}
  const tracked=await env.DB.prepare('SELECT message_id FROM library_messages WHERE guild_id=? AND channel_id=?').bind(guild,channel).first<{message_id:string}>();
  if(tracked&&writer.display_key===p.key){await release(env,guild,channel,writer.lease_owner);return;}
  const current=await projection(env,guild,channel);
  if(!current||(closedOnly&&!current.closed)){await release(env,guild,channel,writer.lease_owner);return;}
  p=current;
  if(!await owned(env,guild,channel,writer.lease_owner)){return;}
  // Do not send an open projection after closing (or yesterday's closure at reopening).
  if(p.closed===libraryWindow()){await release(env,guild,channel,writer.lease_owner);return;}
  if(tracked){
   const result=await patch(env,guild,channel,tracked.message_id,p.content);
   if(result==='sent'){await release(env,guild,channel,writer.lease_owner,null,0,p.key);return;}
   await env.DB.prepare('DELETE FROM library_messages WHERE guild_id=? AND channel_id=? AND message_id=? AND EXISTS(SELECT 1 FROM library_board_state WHERE guild_id=? AND channel_id=? AND lease_owner=?)').bind(guild,channel,tracked.message_id,guild,channel,writer.lease_owner).run();
  }
  const latest=await projection(env,guild,channel);
  if(!latest||latest.closed||await blockedPost(env,guild,channel)){await release(env,guild,channel,writer.lease_owner);return;}
  if(latest.watch?.event_id&&await env.DB.prepare("SELECT id FROM deliveries WHERE id=? AND state IN ('pending','retry','sending') AND expires_at>?").bind(latest.watch.event_id,nowIso()).first()){
   await release(env,guild,channel,writer.lease_owner);return;
  }
  if(!env.DISCORD_TOKEN)throw new LibraryBoardRetry(900);
  const expiresAt=new Date(Math.min(Date.parse(latest.watch!.source_at)+FRESH_MS,Date.parse(latest.watch!.observed_at)+FRESH_MS,Date.parse(`${latest.watch!.day}T13:00:00.000Z`))).toISOString();
  await post(env,guild,channel,writer,latest,`library:${guild}:bootstrap:${crypto.randomUUID()}`,true,expiresAt);
 }catch(error){
  await release(env,guild,channel,writer.lease_owner,'Library status update failed',error instanceof LibraryBoardRetry?error.retryAfter:60);throw error;
 }
}
/** Opening POST and direct status PATCH share a writer, avoiding stale-board replacement races. */
export async function sendLibraryOpening(env:Env,id:string,event:unknown):Promise<void>{
 const row=await env.DB.prepare('SELECT guild_id,channel_id,state,expires_at FROM deliveries WHERE id=?').bind(id).first<{guild_id:string;channel_id:string;state:string;expires_at:string}>();
 if(!row||!['pending','retry'].includes(row.state))return;
 const {guild_id:guild,channel_id:channel}=row;
 const expire=()=>env.DB.prepare("UPDATE deliveries SET state='expired',updated_at=? WHERE id=? AND state IN ('pending','retry')").bind(nowIso(),id).run();
 if(typeof event!=='string'||event!==id||!allowedGuild(guild,env)||row.expires_at<=nowIso()){await expire();return;}
 const writer=await acquire(env,guild,channel);if(!writer)throw new LibraryBoardRetry();
 const p=await projection(env,guild,channel);
 if(!p||p.closed||p.watch?.event_id!==event||p.watch.remaining<=0){await expire();await release(env,guild,channel,writer.lease_owner);return;}
 if(await blockedPost(env,guild,channel)){
  await env.DB.prepare("UPDATE deliveries SET state='uncertain',error='Library route POST quarantined',updated_at=? WHERE id=? AND state IN ('pending','retry')").bind(nowIso(),id).run();
  await release(env,guild,channel,writer.lease_owner,'Library route POST quarantined');return;
 }
 try{await post(env,guild,channel,writer,p,id,false,row.expires_at);}
 catch(error){await release(env,guild,channel,writer.lease_owner,'Library opening update failed',error instanceof LibraryBoardRetry?error.retryAfter:60);throw error;}
}
async function reconcile(env:Env,closedOnly:boolean){
 const at=nowIso();
 await env.DB.prepare("INSERT INTO health(id,last_attempt) VALUES('library-board',?) ON CONFLICT(id) DO UPDATE SET last_attempt=excluded.last_attempt").bind(at).run();
 let failed=false;
 const rows=await env.DB.prepare('SELECT id,library_channel AS channel FROM guilds WHERE library_channel IS NOT NULL').all<{id:string;channel:string}>();
 for(const row of rows.results){if(!allowedGuild(row.id,env))continue;try{await updateLibraryBoard(env,row.id,row.channel,closedOnly);}catch{failed=true;}}
 if(failed)await env.DB.prepare("UPDATE health SET error='Library display update deferred; last confirmed display preserved' WHERE id='library-board'").run();
 else await env.DB.prepare("UPDATE health SET last_success=?,error=NULL WHERE id='library-board'").bind(nowIso()).run();
}
export async function updateLibraryBoards(env:Env){await reconcile(env,false);}
/** Uses existing quarter-hour Cron; no source reads, Queue sends or nighttime POSTs. */
export async function closeLibraryBoards(env:Env,scheduledTime:number){
 if(libraryWindow()||libraryWindow(scheduledTime)||Math.abs(Date.now()-scheduledTime)>60_000)return;
 await reconcile(env,true);
}
