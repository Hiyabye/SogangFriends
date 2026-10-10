import type {Env,Notice} from './types';
import {SOURCES} from './sources';
import {validateNoticeSnapshot,verifyCollectorRequest} from './notice-ingest';
import {nowIso} from './storage';
import {todayKst} from './time';
const MAX_REQUEST=2*1024*1024,MAX_BODY=1024*1024;
interface RawNotice {notice:Notice;bodyHtml:string;attachments:string[];imageUrls:string[]}
interface Progress {source:string;page:number;state:'active'|'done';updated_at:string;started_at:string}
type ArchiveAction={action:'status'|'start'}|{action:'missing';source:string;ids:string[];includeUnavailable:boolean}|{action:'record';raw:RawNotice}|{action:'unavailable';notice:Notice;status:404|410}|{action:'commit';source:string;page:number;ids:string[];done:boolean};
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid archive payload');return v as Record<string,unknown>;};
function sourceId(value:unknown):string {if(typeof value!=='string'||!SOURCES.some(s=>s.id===value))throw new Error('Invalid archive source');return value;}
function ids(value:unknown):string[] {
 if(!Array.isArray(value)||value.length>50||value.some(id=>typeof id!=='string'||!/^[1-9]\d{0,19}$/.test(id))||new Set(value).size!==value.length)throw new Error('Invalid archive IDs');return value;
}
function references(value:unknown):string[] {
 if(!Array.isArray(value)||value.length>100)throw new Error('Invalid archive references');
 return value.map(link=>{if(typeof link!=='string'||link.length>2000)throw new Error('Invalid archive reference');const url=new URL(link);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid archive reference');return link;});
}
function validateRaw(value:unknown):RawNotice {
 const raw=object(value),n=object(raw.notice);
 const notice=validateNoticeSnapshot({source:n.source,notices:[n]}).notices[0];
 if(typeof raw.bodyHtml!=='string'||new TextEncoder().encode(raw.bodyHtml).length>MAX_BODY)throw new Error('Invalid raw body');
 const validated={notice,bodyHtml:raw.bodyHtml,attachments:references(raw.attachments),imageUrls:references(raw.imageUrls)};
 // D1's row maximum is 2,000,000 bytes, not 2 MiB. Leave space for SQLite row headers,
 // identity/hash/timestamp columns; body HTML is stored as TEXT, not escaped JSON.
 const bytes=new TextEncoder();
 const rowBytes=bytes.encode(validated.bodyHtml).length+bytes.encode(JSON.stringify(notice)).length+bytes.encode(JSON.stringify(validated.attachments)).length+bytes.encode(JSON.stringify(validated.imageUrls)).length;
 if(rowBytes>1_900_000)throw new Error('Archive raw row exceeds D1 size limit');
 return validated;
}
function action(value:unknown):ArchiveAction {
 const v=object(value);
 if(v.action==='status'||v.action==='start')return {action:v.action};
 if(v.action==='record')return {action:'record',raw:validateRaw(v.raw)};
 if(v.action==='unavailable'){
  const n=object(v.notice),notice=validateNoticeSnapshot({source:n.source,notices:[n]}).notices[0];
  if(v.status!==404&&v.status!==410)throw new Error('Invalid unavailable status');
  return {action:'unavailable',notice,status:v.status};
 }
 const source=sourceId(v.source),list=ids(v.ids);
 if(v.action==='missing'){
  if(v.includeUnavailable!==undefined&&typeof v.includeUnavailable!=='boolean')throw new Error('Invalid unavailable option');
  return {action:'missing',source,ids:list,includeUnavailable:v.includeUnavailable===true};
 }
 if(v.action==='commit'&&Number.isSafeInteger(v.page)&&Number(v.page)>=1&&Number(v.page)<=1_000_000&&typeof v.done==='boolean'&&(list.length>0||v.done))return {action:'commit',source,page:Number(v.page),ids:list,done:v.done};
 throw new Error('Invalid archive action');
}
async function missing(env:Env,source:string,list:string[],includeUnavailable=false):Promise<string[]> {
 if(!list.length)return [];
 // Requested IDs drive indexed probes; neither source history nor the ID bindings are duplicated.
 const sql=`WITH requested(id) AS (VALUES ${list.map(()=>'(?)').join(',')}) SELECT id FROM requested WHERE EXISTS(SELECT 1 FROM notice_archive JOIN notice_archive_raw USING(source,id) WHERE source=? AND notice_archive.id=requested.id)${includeUnavailable?' OR EXISTS(SELECT 1 FROM notice_archive_unavailable WHERE source=? AND notice_archive_unavailable.id=requested.id)':''}`;
 const rows=await env.DB.prepare(sql).bind(...list,source,...(includeUnavailable?[source]:[])).all<{id:string}>();
 const present=new Set(rows.results.map(row=>row.id));return list.filter(id=>!present.has(id));
}
async function hash(raw:RawNotice):Promise<string> {
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(raw)));
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
async function record(env:Env,raw:RawNotice):Promise<Response> {
 const {notice}=raw,key=`raw/${notice.source}/${notice.id}.json`;
 const lookup=await env.DB.prepare('SELECT raw_key,notice_archive_raw.id AS body_id FROM notice_archive LEFT JOIN notice_archive_raw USING(source,id) WHERE source=? AND id=?').bind(notice.source,notice.id).all<{raw_key:string;body_id:string|null}>();
 const existing=lookup.results[0];
 if(existing){
  // 0004 does not migrate pre-existing R2 captures. Never acknowledge an index-only
  // legacy row or silently replace its original capture with a newly fetched body.
  if(!existing.body_id)throw new Error('Archive body migration required');
  return Response.json({recorded:false,key:existing.raw_key});
 }
 // Leave 100 MB of the Free database for live notices, meals and delivery state.
 // Use supported D1 metadata, not unsupported database-size PRAGMAs.
 const size=lookup.meta.size_after;
 if(!Number.isFinite(size)||size<0||size>=400_000_000)return new Response('Archive capacity reached; live bot headroom preserved',{status:503});
 const at=nowIso(),contentHash=await hash(raw);
 // The first committed row wins. Derive the index from that winning row, not this request,
 // so concurrent captures cannot pair one body with another request's hash/metadata.
 await env.DB.batch([
  env.DB.prepare('INSERT OR IGNORE INTO notice_archive_raw(source,id,notice_json,body_html,attachments_json,image_urls_json,content_hash,captured_at) VALUES(?,?,?,?,?,?,?,?)').bind(notice.source,notice.id,JSON.stringify(notice),raw.bodyHtml,JSON.stringify(raw.attachments),JSON.stringify(raw.imageUrls),contentHash,at),
  env.DB.prepare("INSERT OR IGNORE INTO notice_archive(source,id,title,published,url,raw_key,content_hash,captured_at) SELECT source,id,json_extract(notice_json,'$.title'),json_extract(notice_json,'$.published'),json_extract(notice_json,'$.url'),?,content_hash,captured_at FROM notice_archive_raw WHERE source=? AND id=?").bind(key,notice.source,notice.id)
 ]);
 // Do not insert into notices here: a live snapshot must still see new IDs and create alerts.
 return Response.json({recorded:true,key});
}
async function commit(env:Env,input:Extract<ArchiveAction,{action:'commit'}>):Promise<Response> {
 const progress=await env.DB.prepare('SELECT source,page,state,updated_at,started_at FROM notice_archive_progress WHERE source=?').bind(input.source).first<Progress>();
 if(!progress||input.page>progress.page||input.page===progress.page&&progress.state==='done')return new Response('Archive cursor conflict',{status:409});
 if(input.page<progress.page)return Response.json({committed:true,replayed:true,page:progress.page,state:progress.state});
 if((await missing(env,input.source,input.ids,true)).length)return new Response('Archive page incomplete',{status:409});
 const writes:D1PreparedStatement[]=[];
 // One bounded bulk insert stays below Free-plan query/parameter limits. Publications since
 // the original KST start day remain unseen by live polling, so backfill cannot swallow their alerts.
 if(input.ids.length)writes.push(env.DB.prepare(`INSERT OR IGNORE INTO notices(source,id,title,published,url,collected_at) SELECT source,id,title,published,url,captured_at FROM notice_archive WHERE source=? AND id IN (${input.ids.map(()=>'?').join(',')}) AND published<? AND EXISTS(SELECT 1 FROM notice_archive_progress WHERE source=? AND page=? AND state='active')`).bind(input.source,...input.ids,todayKst(new Date(progress.started_at)),input.source,input.page));
 writes.push(env.DB.prepare("UPDATE notice_archive_progress SET page=?,state=?,updated_at=? WHERE source=? AND page=? AND state='active'").bind(input.page+1,input.done?'done':'active',nowIso(),input.source,input.page));
 await env.DB.batch(writes);
 const final=await env.DB.prepare('SELECT source,page,state,updated_at,started_at FROM notice_archive_progress WHERE source=?').bind(input.source).first<Progress>();
 if(!final||final.page<=input.page)return new Response('Archive cursor conflict',{status:409});
 return Response.json({committed:true,replayed:false,page:final.page,state:final.state});
}
export async function handleNoticeArchive(request:Request,env:Env):Promise<Response> {
 if(env.NOTICE_ARCHIVE_ENABLED!=='true'||!env.NOTICE_INGEST_SECRET||env.NOTICE_INGEST_SECRET.length<32)return new Response('Notice archive disabled',{status:503});
 const verified=await verifyCollectorRequest(request,env.NOTICE_INGEST_SECRET,MAX_REQUEST);if(verified instanceof Response)return verified;
 let input:ArchiveAction;
 try{input=action(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(verified.body)));}catch{return new Response('Invalid archive payload',{status:400});}
 if(Math.abs(Date.now()-Number(verified.timestamp))>5*60_000)return new Response('Unauthorized',{status:401});
 try {
  switch(input.action){
   case 'start':{const at=nowIso();await env.DB.batch(SOURCES.map(source=>env.DB.prepare("INSERT OR IGNORE INTO notice_archive_progress(source,page,state,updated_at,started_at) VALUES(?,1,'active',?,?)").bind(source.id,at,at)));return Response.json({started:true});}
   case 'status':{const result=await env.DB.prepare('SELECT source,page,state,updated_at,started_at FROM notice_archive_progress ORDER BY source').all<Progress>();return Response.json({sources:result.results});}
   case 'missing':return Response.json({missing:await missing(env,input.source,input.ids,input.includeUnavailable)});
   case 'unavailable':{
    await env.DB.prepare('INSERT OR IGNORE INTO notice_archive_unavailable(source,id,status,checked_at) VALUES(?,?,?,?)').bind(input.notice.source,input.notice.id,input.status,nowIso()).run();
    return Response.json({unavailable:true,source:input.notice.source,id:input.notice.id,status:input.status});
   }
   case 'record':return await record(env,input.raw);
   case 'commit':return await commit(env,input);
  }
 }catch{return new Response('Notice archive unavailable; retry the same signed request',{status:503});}
}
