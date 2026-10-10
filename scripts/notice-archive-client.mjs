import {createHmac} from 'node:crypto';
import {validateEndpoint} from './notice-collector.mjs';
import {SourceHttpError} from '../src/sources.ts';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function retryDelay(response,attempt,now) {
 const value=response?.headers.get('retry-after');
 if(value){
  const seconds=/^\d+(?:\.\d+)?$/.test(value)?Number(value):(Date.parse(value)-now)/1000;
  if(Number.isFinite(seconds)&&seconds>30)throw new Error('Archive retry requested beyond bounded run');
  if(Number.isFinite(seconds)&&seconds>0)return seconds*1000;
 }
 return attempt*1000;
}
async function readResult(response) {
 if(!response.body)throw new Error('Invalid archive acknowledgement');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64*1024)throw new Error('Archive acknowledgement exceeds size limit');chunks.push(value);}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid archive acknowledgement');
  return result;
 }finally{void reader.cancel().catch(()=>{});}
}
export function createArchiveClient({endpoint,secret,fetcher=fetch,sleep=delay,now=Date.now}={}) {
 const url=new URL(validateEndpoint(endpoint));url.pathname='/internal/notice-archive';
 if(typeof secret!=='string'||secret.length<32)throw new Error('NOTICE_INGEST_SECRET must contain at least 32 characters');
 return async payload=>{
  const body=JSON.stringify(payload),timestamp=String(now());
  if(Buffer.byteLength(body)>2*1024*1024)throw new Error('Archive request exceeds size limit');
  const headers={'content-type':'application/json','x-collector-timestamp':timestamp,'x-collector-signature':createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')};
  for(let attempt=1;attempt<=3;attempt++){
   let response,result;
   try{
    response=await fetcher(url.href,{method:'POST',redirect:'manual',headers,body,signal:AbortSignal.timeout(20_000)});
    if(response.status===200)result=await readResult(response);
   }catch{
    if(attempt===3)throw new Error('Archive transport/acknowledgement failed after bounded retries');
    await sleep(retryDelay(undefined,attempt,now()));continue;
   }
   if(response.status===200)return result;
   await response.body?.cancel().catch(()=>{});
   if(response.status!==429&&response.status<500)throw new Error(`Archive rejected request (HTTP ${response.status})`);
   if(attempt===3)throw new Error(`Archive unavailable after bounded retries (HTTP ${response.status})`);
   await sleep(retryDelay(response,attempt,now()));
  }
 };
}
export async function captureRawNotices(source,notices,{client,collectRaw,sleep=delay,paceMs=3000,beforeRecord=()=>true,allowUnavailable=false}={}) {
 const ids=notices.map(notice=>notice.id),result=await client({action:'missing',source:source.id,ids,...(allowUnavailable?{includeUnavailable:true}:{})});
 if(!Array.isArray(result.missing)||new Set(result.missing).size!==result.missing.length||result.missing.some(id=>typeof id!=='string'||!ids.includes(id)))throw new Error('Invalid archive missing-ID acknowledgement');
 const missing=new Set(result.missing);let captured=0,unavailable=0;
 const progress=complete=>({complete,captured,...(allowUnavailable?{unavailable}:{})});
 for(const notice of notices){
  if(!missing.has(notice.id))continue;
  if(!beforeRecord())return progress(false);
  await sleep(paceMs);
  let raw;
  try{raw=await collectRaw(notice);}catch(error){
   if(!allowUnavailable||!(error instanceof SourceHttpError)||![404,410].includes(error.status))throw error;
   const acknowledgement=await client({action:'unavailable',notice,status:error.status});
   if(acknowledgement.unavailable!==true||acknowledgement.source!==source.id||acknowledgement.id!==notice.id||acknowledgement.status!==error.status)throw new Error('Invalid archive unavailable acknowledgement');
   unavailable++;continue;
  }
  const acknowledgement=await client({action:'record',raw});
  if(typeof acknowledgement.recorded!=='boolean'||acknowledgement.key!==`raw/${source.id}/${notice.id}.json`)throw new Error('Invalid archive record acknowledgement');
  captured++;
 }
 return progress(true);
}
