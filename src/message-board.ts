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
type Outcome={state:'sent';messageId:string}|{state:'retry';seconds:number}|{state:'missing'|'failed'|'uncertain'};
async function send(env:Env,channel:string,input:DiscordMessageInput,id:string|null):Promise<Outcome>{
 if(!env.DISCORD_TOKEN)return {state:'failed'};
 const files=typeof input==='string'?[]:input.files??(input.file?[input.file]:[]);
 // PATCH replaces both sets, including empty ones: no stale files or cards survive.
 const payload={...message(input),embeds:typeof input==='string'?[]:input.embeds??[],attachments:files.map((file,id)=>({id,filename:file.filename}))};
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
interface BoardOptions {
 table:'schedule_messages'|'meal_messages';field:'schedule_channel'|'meals_channel';
 date:string;key:string;hash:string;allowCreate:boolean;
 valid:()=>boolean;render:()=>Promise<DiscordMessageInput>;complete?:()=>boolean;
}
/** Same safety boundary for both boards; SQL identifiers are internal literal unions. */
export async function updateBoard(env:Env,guild:string,channel:string,options:BoardOptions):Promise<void>{
 const {table,field,date,key,hash,allowCreate}=options;
 const configured=async()=> (await env.DB.prepare(`SELECT ${field} AS channel FROM guilds WHERE id=?`).bind(guild).first<{channel:string|null}>())?.channel===channel;
 const valid=async()=>{const matches=await configured();return matches&&date===todayKst()&&options.valid()&&allowedGuild(guild,env);};
 if(!/^\d+$/.test(channel)||!await valid())return;
 const now=new Date().toISOString();
 if(allowCreate)await env.DB.prepare(`INSERT OR IGNORE INTO ${table}(guild_id,channel_id,updated_at) VALUES(?,?,?)`).bind(guild,channel,now).run();
 await env.DB.prepare(`UPDATE ${table} SET state='uncertain',lease_owner=NULL,lease_until=NULL,error='Board creation interrupted; manual reconciliation required',updated_at=? WHERE guild_id=? AND channel_id=? AND state='creating' AND lease_until<?`).bind(now,guild,channel,now).run();
 const owner=crypto.randomUUID();
 const row=await env.DB.prepare(`UPDATE ${table} SET state=CASE WHEN message_id IS NULL THEN 'creating' ELSE 'editing' END,lease_owner=?,lease_until=?,updated_at=?,error=NULL WHERE guild_id=? AND channel_id=? AND state!='uncertain' AND (message_id IS NOT NULL OR ?=1 OR state='retry') AND (lease_owner IS NULL OR (state='editing' AND lease_until<?)) AND (state IN ('retry','editing') OR content_hash IS NULL OR content_hash!=?) AND (projection_key IS NULL OR projection_key<=?) AND (retry_at IS NULL OR retry_at<=?) RETURNING message_id`)
 .bind(owner,new Date(Date.now()+LEASE_MS).toISOString(),now,guild,channel,allowCreate?1:0,now,hash,key,now).first<{message_id:string|null}>();
 if(!row){
  const current=await env.DB.prepare(`SELECT state,retry_at,content_hash FROM ${table} WHERE guild_id=? AND channel_id=?`).bind(guild,channel).first<{state:string;retry_at:string|null;content_hash:string|null}>();
  if(current?.state!=='uncertain'&&(current?.state==='retry'||current?.content_hash!==hash)&&current?.retry_at&&current.retry_at>now)throw new BoardRetry(Math.max(1,Math.ceil((Date.parse(current.retry_at)-Date.now())/1000)));
  if(current?.state==='creating'||current?.state==='editing')throw new BoardRetry();
  return;
 }
 const release=async(state:string,error:string|null,id:string|null,success=false,retryAt:string|null=null)=>{
  await env.DB.prepare(`UPDATE ${table} SET state=?,error=?,message_id=?,updated_date=CASE WHEN ?=1 THEN ? ELSE updated_date END,content_hash=CASE WHEN ?=1 THEN ? ELSE content_hash END,projection_key=CASE WHEN ?=1 THEN ? ELSE projection_key END,retry_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE guild_id=? AND channel_id=? AND lease_owner=?`)
   .bind(state,error,id,success?1:0,date,success?1:0,hash,success?1:0,key,retryAt,new Date().toISOString(),guild,channel,owner).run();
 };
 let input:DiscordMessageInput;
 try{input=await options.render();}catch(error){await release('retry','Board preparation failed',row.message_id);throw error;}
 // Includes date/slot transitions during image downloads and configuration changes.
 if(!await valid()){await release('idle',null,row.message_id);return;}
 let outcome=await send(env,channel,input,row.message_id);
 if(outcome.state==='missing'){
  const creating=await env.DB.prepare(`UPDATE ${table} SET message_id=NULL,state='creating' WHERE guild_id=? AND channel_id=? AND lease_owner=? RETURNING guild_id`).bind(guild,channel,owner).first();
  if(!creating)return;row.message_id=null;
  if(!await valid()){await release('idle',null,null);return;}
  outcome=await send(env,channel,input,null);
 }
 if(outcome.state==='sent'){
  if(options.complete&&!options.complete()){
   // The link-only message is real, but transient preparation has not reconciled the intended image.
   await env.DB.prepare(`UPDATE ${table} SET state='retry',message_id=?,content_hash=NULL,projection_key=?,updated_date=?,retry_at=?,lease_owner=NULL,lease_until=NULL,error='Image preparation incomplete',updated_at=? WHERE guild_id=? AND channel_id=? AND lease_owner=?`)
    .bind(outcome.messageId,key,date,new Date(Date.now()+15*60_000).toISOString(),new Date().toISOString(),guild,channel,owner).run();
  }else await release('ready',null,outcome.messageId,true);
  return;
 }
 if(outcome.state==='retry'){await release('retry','Board request safely retryable',row.message_id,false,new Date(Date.now()+outcome.seconds*1000).toISOString());throw new BoardRetry(outcome.seconds);}
 await release(outcome.state,outcome.state==='uncertain'?'Board POST outcome uncertain; manual reconciliation required':'Board request rejected; check channel permissions',row.message_id);
}
