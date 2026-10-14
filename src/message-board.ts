import type {Env} from './types';
import {allowedGuild,message,type DiscordMessageInput} from './discord';
import {todayKst} from './time';
const API='https://discord.com/api/v10',LEASE_MS=20*60_000;
export class BoardRetry extends Error {
 readonly retryAfter:number;
 constructor(seconds=60){super('Board update temporarily unavailable');this.retryAfter=seconds;}
}
export async function boardHash(value:unknown):Promise<string>{
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
 return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function mealDisplayHash(input:DiscordMessageInput):Promise<string>{
 const files=typeof input==='string'?[]:input.files??(input.file?[input.file]:[]);
 const images=await Promise.all(files.map(async file=>({
  mime:file.mime,
  hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(file.bytes).buffer)),byte=>byte.toString(16).padStart(2,'0')).join(''),
 })));
 return boardHash({message:message(input),images});
}
type Outcome={state:'sent';messageId:string}|{state:'retry';seconds:number}|{state:'missing'|'failed'|'uncertain'};
async function send(env:Env,channel:string,input:DiscordMessageInput,id:string|null):Promise<Outcome>{
 if(!env.DISCORD_TOKEN)return {state:'failed'};
 const files=typeof input==='string'?[]:input.files??(input.file?[input.file]:[]);
 // PATCH replaces both sets, including empty ones: no stale files or cards survive.
 const payload={...message(input),...(typeof input!=='string'&&input.components?{}:{embeds:typeof input==='string'?[]:input.embeds??[]}),attachments:files.map((file,id)=>({id,filename:file.filename}))};
 let body:BodyInit=JSON.stringify(payload);const headers:Record<string,string>={Authorization:`Bot ${env.DISCORD_TOKEN}`};
 if(files.length){const form=new FormData();form.append('payload_json',body);for(const [id,file] of files.entries())form.append(`files[${id}]`,new Blob([Uint8Array.from(file.bytes).buffer],{type:file.mime}),file.filename);body=form;}
 else headers['Content-Type']='application/json';
 let response:Response;
 try{response=await fetch(`${API}/channels/${channel}/messages${id?`/${id}`:''}`,{method:id?'PATCH':'POST',headers,body,signal:AbortSignal.timeout(15000)});}
 catch{return id?{state:'retry',seconds:60}:{state:'uncertain'};}
 if(response.status===429){let seconds=60;try{const data=await response.json() as {retry_after?:unknown};if(typeof data.retry_after==='number'&&Number.isFinite(data.retry_after))seconds=Math.min(86400,Math.max(1,Math.ceil(data.retry_after)));}catch{/* Confirmed rejection is safe without metadata. */}return {state:'retry',seconds};}
 if(id&&response.status===404){try{if((await response.json() as {code?:unknown}).code===10008)return {state:'missing'};}catch{/* A generic 404 is not deletion proof. */}return {state:'failed'};}
 if(response.status>=500||response.status===408)return id?{state:'retry',seconds:60}:{state:'uncertain'};
 if(!response.ok)return {state:'failed'};
 if(id)return {state:'sent',messageId:id};
 try{const data=await response.json() as {id?:unknown;channel_id?:unknown};if(typeof data.id==='string'&&/^\d+$/.test(data.id)&&data.channel_id===channel)return {state:'sent',messageId:data.id};}catch{/* Unknown creation must never be replayed. */}
 return {state:'uncertain'};
}
/** Only called with durable, post-success cleanup proof from the meal board. DELETE is idempotent. */
export async function cleanupMealMessage(env:Env,payload:{guild:string;channel:string;messageId:string;replacementId:string}):Promise<void>{
 const {guild,channel,messageId,replacementId}=payload;
 if(![guild,channel,messageId,replacementId].every(value=>/^\d+$/.test(value))||messageId===replacementId)throw new Error('Invalid meal cleanup identity');
 if(!allowedGuild(guild,env))return;
 const current=await env.DB.prepare('SELECT message_id FROM meal_messages WHERE guild_id=? AND channel_id=?').bind(guild,channel).first<{message_id:string|null}>();
 if(!current?.message_id||current.message_id===messageId)throw new Error('Meal cleanup has no replacement tracking');
 if(!env.DISCORD_TOKEN)throw new Error('Meal cleanup token unavailable');
 const response=await fetch(`${API}/channels/${channel}/messages/${messageId}`,{method:'DELETE',headers:{Authorization:`Bot ${env.DISCORD_TOKEN}`},signal:AbortSignal.timeout(15000)});
 if(response.ok)return;
 if(response.status===404){try{if((await response.json() as {code?:unknown}).code===10008)return;}catch{/* A generic 404 is not deletion proof. */}}
 if(response.status===429){let seconds=60;try{const data=await response.json() as {retry_after?:unknown};if(typeof data.retry_after==='number'&&Number.isFinite(data.retry_after))seconds=Math.min(86400,Math.max(1,Math.ceil(data.retry_after)));}catch{/* Retry with the default cooldown. */}throw new BoardRetry(seconds);}
 throw new Error('Meal cleanup failed');
}
interface BoardOptions {
 table:'schedule_messages'|'meal_messages';field:'schedule_channel'|'meals_channel';
 date:string;key:string;hash:string;allowCreate:boolean;replace?:boolean;
 valid:()=>boolean;render:()=>Promise<DiscordMessageInput>;complete?:()=>boolean;
}
/** Same safety boundary for both boards; SQL identifiers are internal literal unions. */
export async function updateBoard(env:Env,guild:string,channel:string,options:BoardOptions):Promise<void>{
 const {table,field,date,key,hash,allowCreate}=options;
 const replace=table==='meal_messages'&&options.replace===true;
 const configured=async()=> (await env.DB.prepare(`SELECT ${field} AS channel FROM guilds WHERE id=?`).bind(guild).first<{channel:string|null}>())?.channel===channel;
 const valid=async()=>{const matches=await configured();return matches&&date===todayKst()&&options.valid()&&allowedGuild(guild,env);};
 if(!/^\d+$/.test(channel)||!await valid())return;
 const now=new Date().toISOString();
 if(allowCreate)await env.DB.prepare(`INSERT OR IGNORE INTO ${table}(guild_id,channel_id,updated_at) VALUES(?,?,?)`).bind(guild,channel,now).run();
 await env.DB.prepare(`UPDATE ${table} SET state='uncertain',lease_owner=NULL,lease_until=NULL,error='Board creation interrupted; manual reconciliation required',updated_at=? WHERE guild_id=? AND channel_id=? AND state='creating' AND lease_until<?`).bind(now,guild,channel,now).run();
 const owner=crypto.randomUUID();
 const row=await env.DB.prepare(`UPDATE ${table} SET state=CASE WHEN message_id IS NULL OR ?=1 THEN 'creating' ELSE 'editing' END,lease_owner=?,lease_until=?,updated_at=?,error=NULL WHERE guild_id=? AND channel_id=? AND state!='uncertain' AND (message_id IS NOT NULL OR ?=1 OR state='retry') AND (lease_owner IS NULL OR (state='editing' AND lease_until<?)) AND (state IN ('retry','editing') OR content_hash IS NULL OR content_hash!=?) AND (projection_key IS NULL OR projection_key<=?) AND (retry_at IS NULL OR retry_at<=?) RETURNING message_id${replace?',display_hash':''}`)
 .bind(replace?1:0,owner,new Date(Date.now()+LEASE_MS).toISOString(),now,guild,channel,allowCreate?1:0,now,hash,key,now).first<{message_id:string|null;display_hash?:string|null}>();
 if(!row){
  const current=await env.DB.prepare(`SELECT state,retry_at,content_hash FROM ${table} WHERE guild_id=? AND channel_id=?`).bind(guild,channel).first<{state:string;retry_at:string|null;content_hash:string|null}>();
  if(current?.state!=='uncertain'&&(current?.state==='retry'||current?.content_hash!==hash)&&current?.retry_at&&current.retry_at>now)throw new BoardRetry(Math.max(1,Math.ceil((Date.parse(current.retry_at)-Date.now())/1000)));
  if(current?.state==='creating'||current?.state==='editing')throw new BoardRetry();
  return;
 }
 let displayHash:string|null=null;
 const release=async(state:string,error:string|null,id:string|null,success=false,retryAt:string|null=null)=>{
  await env.DB.prepare(`UPDATE ${table} SET state=?,error=?,message_id=?,updated_date=CASE WHEN ?=1 THEN ? ELSE updated_date END,content_hash=CASE WHEN ?=1 THEN ? ELSE content_hash END,projection_key=CASE WHEN ?=1 THEN ? ELSE projection_key END${replace?',display_hash=CASE WHEN ?=1 THEN ? ELSE display_hash END':''},retry_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE guild_id=? AND channel_id=? AND lease_owner=?`)
   .bind(state,error,id,success?1:0,date,success?1:0,hash,success?1:0,key,...(replace?[success?1:0,displayHash]:[]),retryAt,new Date().toISOString(),guild,channel,owner).run();
 };
 let input:DiscordMessageInput;
 try{input=await options.render();if(replace)displayHash=await mealDisplayHash(input);}catch(error){await release('retry','Board preparation failed',row.message_id);throw error;}
 // Includes date/slot transitions during image downloads and configuration changes.
 if(!await valid()){await release('idle',null,row.message_id);return;}
 const incomplete=options.complete&&!options.complete();
 if(replace&&row.message_id&&row.display_hash===displayHash){
  // Retry missing images without notifying again when the displayed fallback is unchanged.
  await release(incomplete?'retry':'ready',incomplete?'Image preparation incomplete':null,row.message_id,true,incomplete?new Date(Date.now()+15*60_000).toISOString():null);
  return;
 }
 let outcome=await send(env,channel,input,replace?null:row.message_id);
 if(outcome.state==='missing'){
  const creating=await env.DB.prepare(`UPDATE ${table} SET message_id=NULL,state='creating' WHERE guild_id=? AND channel_id=? AND lease_owner=? RETURNING guild_id`).bind(guild,channel,owner).first();
  if(!creating)return;row.message_id=null;
  if(!await valid()){await release('idle',null,null);return;}
  outcome=await send(env,channel,input,null);
 }
 if(outcome.state==='sent'){
  const at=new Date().toISOString();
  if(replace&&row.message_id){
   // Persist deletion proof and the new serving ID atomically before touching the old message.
   const cleanupId=`meal-cleanup:${guild}:${channel}:${row.message_id}:${outcome.messageId}`;
   await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO jobs(id,kind,payload,created_at,available_at) SELECT ?,'meal-cleanup',?,?,? FROM meal_messages WHERE guild_id=? AND channel_id=? AND lease_owner=?")
     .bind(cleanupId,JSON.stringify({guild,channel,messageId:row.message_id,replacementId:outcome.messageId}),at,at,guild,channel,owner),
    env.DB.prepare("UPDATE meal_messages SET state=?,message_id=?,content_hash=?,display_hash=?,projection_key=?,updated_date=?,retry_at=?,lease_owner=NULL,lease_until=NULL,error=?,updated_at=? WHERE guild_id=? AND channel_id=? AND lease_owner=?")
     .bind(incomplete?'retry':'ready',outcome.messageId,hash,displayHash,key,date,incomplete?new Date(Date.now()+15*60_000).toISOString():null,incomplete?'Image preparation incomplete':null,at,guild,channel,owner)
   ]);
   const cleanup=await env.DB.prepare("SELECT payload FROM jobs WHERE id=? AND state='pending'").bind(cleanupId).first<{payload:string}>();
   if(cleanup){
    try{await cleanupMealMessage(env,JSON.parse(cleanup.payload));await env.DB.prepare("UPDATE jobs SET state='done' WHERE id=? AND state='pending'").bind(cleanupId).run();}
    catch(error){
     // Honor Discord's cooldown while durable cleanup retries independently of the POST.
     const seconds=error instanceof BoardRetry?error.retryAfter:60;
     await env.DB.prepare("UPDATE jobs SET available_at=?,error='Meal cleanup deferred' WHERE id=? AND state='pending'")
      .bind(new Date(Date.now()+seconds*1000).toISOString(),cleanupId).run();
    }
   }
   return;
  }
  if(replace){
   await release(incomplete?'retry':'ready',incomplete?'Image preparation incomplete':null,outcome.messageId,true,incomplete?new Date(Date.now()+15*60_000).toISOString():null);
  }else if(incomplete){
   // The link-only message is real, but transient preparation has not reconciled the intended image.
   await env.DB.prepare(`UPDATE ${table} SET state='retry',message_id=?,content_hash=NULL,projection_key=?,updated_date=?,retry_at=?,lease_owner=NULL,lease_until=NULL,error='Image preparation incomplete',updated_at=? WHERE guild_id=? AND channel_id=? AND lease_owner=?`)
    .bind(outcome.messageId,key,date,new Date(Date.now()+15*60_000).toISOString(),new Date().toISOString(),guild,channel,owner).run();
  }else await release('ready',null,outcome.messageId,true);
  return;
 }
 if(outcome.state==='retry'){await release('retry','Board request safely retryable',row.message_id,false,new Date(Date.now()+outcome.seconds*1000).toISOString());throw new BoardRetry(outcome.seconds);}
 await release(outcome.state,outcome.state==='uncertain'?'Board POST outcome uncertain; manual reconciliation required':'Board request rejected; check channel permissions',row.message_id);
}
