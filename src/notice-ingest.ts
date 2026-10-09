import type {Env,Notice} from './types';
import {SOURCES} from './sources';
import {validDate} from './time';
import {enqueue} from './storage';
const LIMIT=256*1024;
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export function validateNoticeSnapshot(value:unknown):{source:string;notices:Notice[]} {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid snapshot');
 const data=value as Record<string,unknown>;const source=SOURCES.find(s=>s.id===data.source);
 if(!source||!Array.isArray(data.notices)||!data.notices.length||data.notices.length>100)throw new Error('Invalid snapshot source or count');
 const ids=new Set<string>();
 const notices=data.notices.map((value:unknown)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid notice');
  const n=value as Record<string,unknown>;
  if(typeof n.id!=='string'||! /^[1-9]\d{0,19}$/.test(n.id)||ids.has(n.id)||n.source!==source.id||typeof n.title!=='string'||!n.title.trim()||n.title.length>1000||typeof n.published!=='string'||!validDate(n.published))throw new Error('Invalid notice');
  const url=source.kind==='university'?`https://www.sogang.ac.kr/ko/detail/${n.id}?bbsConfigFk=2`:`https://computing.sogang.ac.kr/ko/community/${source.id}/detail/${n.id}`;
  if(n.url!==url)throw new Error('Invalid notice URL');
  ids.add(n.id);return {id:n.id,source:source.id,title:n.title.trim(),published:n.published,url};
 });
 return {source:source.id,notices};
}
export async function handleNoticeIngest(request:Request,env:Env):Promise<Response> {
 if(env.NOTICE_COLLECTION_MODE!=='external'||!env.NOTICE_INGEST_SECRET||env.NOTICE_INGEST_SECRET.length<32)return new Response('Collector ingestion disabled',{status:503});
 const timestamp=request.headers.get('x-collector-timestamp')??'',signature=request.headers.get('x-collector-signature')??'';
 if(!/^\d{13}$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>5*60_000||! /^[a-f0-9]{64}$/.test(signature))return new Response('Unauthorized',{status:401});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return new Response('Expected JSON',{status:415});
 if(Number(request.headers.get('content-length'))>LIMIT)return new Response('Snapshot too large',{status:413});
 if(!request.body)return new Response('Missing snapshot',{status:400});
 const reader=request.body.getReader();const chunks:Uint8Array[]=[];let length=0,tooLarge=false,timedOut=false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error('Snapshot read timed out'));},10_000);});
 const read=async()=>{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>LIMIT){tooLarge=true;throw new Error('Snapshot too large');}chunks.push(value);}};
 try{await Promise.race([read(),timeout]);}
 catch{void reader.cancel().catch(()=>{});return new Response(tooLarge?'Snapshot too large':timedOut?'Snapshot read timed out':'Invalid snapshot stream',{status:tooLarge?413:timedOut?408:400});}
 finally{clearTimeout(timer);}
 const prefix=new TextEncoder().encode(`${timestamp}.`);const signed=new Uint8Array(prefix.length+length);signed.set(prefix);let at=prefix.length;
 for(const chunk of chunks){signed.set(chunk,at);at+=chunk.length;}
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.NOTICE_INGEST_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const signatureBytes=new Uint8Array(signature.match(/../g)!.map(v=>parseInt(v,16)));
 if(!await crypto.subtle.verify('HMAC',key,signatureBytes,signed))return new Response('Unauthorized',{status:401});
 let snapshot:{source:string;notices:Notice[]};
 try{snapshot=validateNoticeSnapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(signed.subarray(prefix.length))));}
 catch{return new Response('Invalid snapshot',{status:400});}
 const id=`notice-snapshot:${snapshot.source}:${hex(await crypto.subtle.digest('SHA-256',signed))}`;
 // A slow client must not extend the signature window by passing the initial header check.
 if(Math.abs(Date.now()-Number(timestamp))>5*60_000)return new Response('Unauthorized',{status:401});
 try{
  await enqueue(env,id,'notice-snapshot',snapshot);
  await env.JOBS.send({id});
  return Response.json({accepted:true,id},{status:202});
 }catch{return new Response('Snapshot dispatch unavailable; retry the same signed request',{status:503});}
}
