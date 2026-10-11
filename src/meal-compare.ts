import type {Env} from './types';
import {verifyCollectorRequest} from './notice-ingest';
import {dayDifference,validDate} from './time';

const MODEL='dots-studio/dots-3-note-preview:free';
const KIND='meal-actions-compare';
interface ComparisonConfig {
 model:typeof MODEL;
 expected:{start:string;end:string;published:string};
 imageUrl:string;sourceUrl:string;imageHash:string;maxAttempts:2;expiresAt:string;
}
interface ComparisonJob {kind:string;state:string;payload:string}
interface Report {runId:string;state:'completed'|'safe_retry'|'reserved';actualCost:number|null;attempts:number}
function object(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid comparison');
 return value as Record<string,unknown>;
}
function exactKeys(value:Record<string,unknown>,keys:string[]):boolean {
 return Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}
function config(payload:Record<string,unknown>):ComparisonConfig {
 const expected=object(payload.expected);
 if(payload.model!==MODEL||payload.maxAttempts!==2||!exactKeys(expected,['start','end','published'])||!validDate(expected.start)||!validDate(expected.end)||!validDate(expected.published)||dayDifference(expected.start,expected.end)!==6||new Date(expected.start).getUTCDay()!==1||Math.abs(dayDifference(expected.start,expected.published))>45)throw new Error('Invalid comparison config');
 if(typeof payload.imageHash!=='string'||!/^[a-f0-9]{64}$/.test(payload.imageHash)||typeof payload.imageUrl!=='string'||!/^https:\/\/scc\.sogang\.ac\.kr\/dataview\/board\/1185\/[A-Za-z0-9_-]+\.jpg$/.test(payload.imageUrl)||typeof payload.sourceUrl!=='string'||!/^https:\/\/scc\.sogang\.ac\.kr\/front\/cmsboardview\.do\?bbsConfigFK=1185&siteId=dormitory&pkid=[1-9]\d{0,19}$/.test(payload.sourceUrl))throw new Error('Invalid comparison source');
 if(typeof payload.expiresAt!=='string'||!Number.isFinite(Date.parse(payload.expiresAt))||new Date(payload.expiresAt).toISOString()!==payload.expiresAt)throw new Error('Invalid comparison expiry');
 return {model:MODEL,expected:{start:expected.start,end:expected.end,published:expected.published},imageUrl:payload.imageUrl,sourceUrl:payload.sourceUrl,imageHash:payload.imageHash,maxAttempts:2,expiresAt:payload.expiresAt};
}
function sameReport(payload:string,report:Report):boolean {
 try {
  const stored=object(object(JSON.parse(payload)).report);
  return exactKeys(stored,['runId','state','actualCost','attempts'])&&Object.entries(report).every(([key,value])=>stored[key]===value);
 }catch{return false;}
}

/** An operator creates the ticket and normal-cap reservation; this API cannot create either. */
export async function handleMealCompare(request:Request,env:Env):Promise<Response> {
 if(!env.NOTICE_INGEST_SECRET||env.NOTICE_INGEST_SECRET.length<32)return new Response('Comparison disabled',{status:503});
 const verified=await verifyCollectorRequest(request,env.NOTICE_INGEST_SECRET,8*1024);
 if(verified instanceof Response)return verified;
 let input:Record<string,unknown>;
 try {
  input=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(verified.body)));
  if(typeof input.id!=='string'||!/^actions-meal-compare:[a-f0-9]{32}$/.test(input.id)||typeof input.runId!=='string'||! /^[1-9]\d{0,19}$/.test(input.runId))throw new Error('Invalid identity');
  if(input.action==='claim') {
   if(!exactKeys(input,['action','id','runId']))throw new Error('Invalid claim');
  }else if(input.action==='report') {
   if(!exactKeys(input,['action','id','runId','state','actualCost','attempts'])||!['completed','safe_retry','reserved'].includes(String(input.state))||!(input.actualCost===null||(typeof input.actualCost==='number'&&Number.isFinite(input.actualCost)&&input.actualCost>=0))||typeof input.attempts!=='number'||!Number.isInteger(input.attempts)||input.attempts<1||input.attempts>2)throw new Error('Invalid report');
  }else throw new Error('Invalid action');
 }catch{return new Response('Invalid comparison request',{status:400});}
 const id=input.id as string,runId=input.runId as string;
 try {
  const job=await env.DB.prepare('SELECT kind,state,payload FROM jobs WHERE id=?').bind(id).first<ComparisonJob>();
  if(!job||job.kind!==KIND)return new Response('Comparison unavailable',{status:409});
  let payload:Record<string,unknown>,pinned:ComparisonConfig;
  try {payload=object(JSON.parse(job.payload));pinned=config(payload);}
  catch{return new Response('Comparison unavailable',{status:409});}
  if(input.action==='claim') {
   if(env.LLM_ENABLED!=='true'||job.state!=='comparison_ready'||payload.githubRunId!==undefined||payload.report!==undefined||Date.parse(pinned.expiresAt)<=Date.now())return new Response('Comparison unavailable',{status:409});
   // A single conditional write elects the runner. Lost claim acknowledgements are
   // deliberately not replayable: the runner must stop before making inference.
   const claimed=await env.DB.prepare("UPDATE jobs SET state='comparison_running',payload=json_set(payload,'$.githubRunId',?),error=NULL WHERE id=? AND kind=? AND state='comparison_ready' AND payload=? AND json_extract(payload,'$.expiresAt')>? AND EXISTS(SELECT 1 FROM llm_usage WHERE id=? AND state='reserved' AND reserved_usd>0) RETURNING id").bind(runId,id,KIND,job.payload,new Date().toISOString(),id).first();
   if(!claimed)return new Response('Comparison unavailable',{status:409});
   return Response.json({id,runId,...pinned});
  }
  const report:Report={runId,state:input.state as Report['state'],actualCost:input.actualCost as number|null,attempts:input.attempts as number};
  if(payload.githubRunId!==runId)return new Response('Comparison unavailable',{status:409});
  if((job.state==='comparison_done'||job.state==='needs_review')&&sameReport(job.payload,report))return Response.json({recorded:true});
  if(job.state!=='comparison_running')return new Response('Comparison unavailable',{status:409});
  const reportJson=JSON.stringify(report),terminal=report.state==='reserved'?'needs_review':'comparison_done';
  // Add this whole-run observed cost once. Unknown costs/reservations stay held;
  // an exact report replay never increments cost or changes the terminal result.
  await env.DB.batch([
   env.DB.prepare("UPDATE llm_usage SET state=?,actual_usd=CASE WHEN ? IS NULL THEN actual_usd ELSE COALESCE(actual_usd,0)+? END WHERE id=? AND state='reserved' AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND kind=? AND state='comparison_running' AND payload=? AND json_extract(payload,'$.githubRunId')=?)").bind(report.state,report.actualCost,report.actualCost,id,id,KIND,job.payload,runId),
   env.DB.prepare("UPDATE jobs SET state=?,attempts=?,payload=json_set(payload,'$.report',json(?)),error=? WHERE id=? AND kind=? AND state='comparison_running' AND payload=? AND changes()=1 AND EXISTS(SELECT 1 FROM llm_usage WHERE id=? AND state=?)").bind(terminal,report.attempts,reportJson,report.state==='reserved'?'Actions inference outcome uncertain':null,id,KIND,job.payload,id,report.state)
  ]);
  const saved=await env.DB.prepare('SELECT payload FROM jobs WHERE id=? AND kind=?').bind(id,KIND).first<{payload:string}>();
  if(!saved||!sameReport(saved.payload,report))return new Response('Comparison unavailable',{status:409});
  return Response.json({recorded:true});
 }catch{return new Response('Comparison unavailable',{status:503});}
}
