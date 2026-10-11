import {createHash,createHmac} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {extractMeal,MealExtractionError} from '../src/meals.ts';
import {fetchImage} from '../src/sources.ts';
import {verifyCertificate} from './notice-collector.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function compareMeal(config,key,{extract=extractMeal,loadImage=fetchImage,sleep=delay,now=Date.now}={}) {
 const result={id:config.id,runId:config.runId,sourceUrl:config.sourceUrl,imageHash:config.imageHash,expected:config.expected,model:config.model,settings:{disableReasoning:true,maxTokens:6000,timeoutMs:120000,temperature:0,strictJson:true},state:'safe_retry',actualCost:null,attempts:0,observations:[]};
 if(config.model!=='dots-studio/dots-3-note-preview:free'||config.maxAttempts!==2||!key)throw new Error('Invalid diagnostic configuration');
 let image;
 try{image=await loadImage(config.imageUrl);if(createHash('sha256').update(image.bytes).digest('hex')!==config.imageHash)throw new Error('Changed image');}
 catch{result.attempts=1;result.observations.push({attempt:1,outcome:'image_preflight_failed'});return result;}
 for(let attempt=1;attempt<=config.maxAttempts;attempt++){
  result.attempts=attempt;const started=now();
  try{
   const response=await extract({LLM_ENABLED:'true',OPENROUTER_API_KEY:key,MEAL_MODEL:config.model},image,config.expected,{disableReasoning:true});
   if(response.actualCost!==null)result.actualCost=(result.actualCost??0)+response.actualCost;
   result.state='completed';result.week=response.week;result.observations.push({attempt,outcome:'schema_valid_requires_source_review',durationMs:now()-started});return result;
  }catch(error){
   const known=error instanceof MealExtractionError;
   if(known&&error.actualCost!==null)result.actualCost=(result.actualCost??0)+error.actualCost;
   result.state=known&&error.safeRetry?'safe_retry':'reserved';
   result.observations.push({attempt,outcome:result.state==='reserved'?'uncertain_stop':'confirmed_failure',durationMs:now()-started,reason:known?error.message:'Unexpected extraction failure'});
   if(result.state==='reserved'||attempt===config.maxAttempts)return result;
   await sleep(Math.max(60000,(error.retryAfter??0)*1000));
  }
 }
 return result;
}
export async function comparisonRequest(endpoint,secret,value,{fetcher=fetch}={}) {
 const url=new URL(endpoint);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/internal/meal-compare'||typeof secret!=='string'||secret.length<32)throw new Error('Invalid diagnostic endpoint or secret');
 const body=JSON.stringify(value),timestamp=String(Date.now());
 const response=await fetcher(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json','x-collector-timestamp':timestamp,'x-collector-signature':createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')},body});
 if(!response.ok){await response.body?.cancel();throw new Error(`Diagnostic endpoint HTTP ${response.status}`);}
 // The endpoint projects only its small pinned configuration or acknowledgement.
 const text=await response.text();if(text.length>8192)throw new Error('Diagnostic acknowledgement too large');return JSON.parse(text);
}
async function main(){
 if(process.env.GITHUB_RUN_ATTEMPT!=='1')throw new Error('Reruns are prohibited; request a new reservation');
 const runId=process.env.GITHUB_RUN_ID,id=process.env.MEAL_COMPARE_TICKET,key=process.env.OPENROUTER_API_KEY;
 if(!/^\d+$/.test(runId??'')||!/^actions-meal-compare:[a-f0-9]{32}$/.test(id??'')||!key)throw new Error('Diagnostic environment missing');
 verifyCertificate();
 const base=new URL(process.env.NOTICE_INGEST_URL);
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/internal/notices')throw new Error('Invalid Worker endpoint');
 const endpoint=new URL('/internal/meal-compare',base).href,secret=process.env.NOTICE_INGEST_SECRET;
 // Claim is deliberately not retried: a lost acknowledgement never authorizes inference.
 const config=await comparisonRequest(endpoint,secret,{action:'claim',id,runId});
 const result=await compareMeal(config,key);result.commit=process.env.GITHUB_SHA;
 mkdirSync('meal-comparison-result',{recursive:true});
 writeFileSync('meal-comparison-result/result.json',JSON.stringify(result,null,2)+'\n');
 let reported=false;
 for(let attempt=1;attempt<=3;attempt++){
  try{await comparisonRequest(endpoint,secret,{action:'report',id,runId,state:result.state,actualCost:result.actualCost,attempts:result.attempts});reported=true;break;}
  catch{if(attempt<3)await delay(1000*attempt);}
 }
 console.log(JSON.stringify({state:result.state,attempts:result.attempts,reported,requiresSourceReview:!!result.week}));
 if(!reported)throw new Error('Report not acknowledged; preserve reservation and inspect artifact');
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main().catch(()=>{console.error('Controlled meal comparison stopped; inspect its reservation and any diagnostic artifact.');process.exitCode=1;});
