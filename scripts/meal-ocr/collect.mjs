import {createHash,createHmac} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {discoverMealSources,fetchImage} from '../../src/sources.ts';
import {validateMeal} from '../../src/meals.ts';
import {validateCollectorLaunch} from '../notice-collector.mjs';

export const OCR_VERSION='ocr-v1';
const BODY_LIMIT=256*1024,RESPONSE_LIMIT=8192;
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const writeJson=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
export function validateEndpoint(value) {
 let url;try{url=new URL(value);}catch{throw new Error('Invalid OCR ingestion URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/internal/meal-ocr'||url.href!==value)throw new Error('Invalid OCR ingestion URL');
 return url.href;
}
export function signedRequest(value,secret,timestamp=String(Date.now())) {
 if(typeof secret!=='string'||secret.length<32||!/^\d{13}$/.test(timestamp))throw new Error('Invalid OCR signing configuration');
 const body=JSON.stringify(value);
 if(Buffer.byteLength(body)>BODY_LIMIT)throw new Error('OCR request too large');
 return {body,headers:{'content-type':'application/json','x-collector-timestamp':timestamp,'x-collector-signature':createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}};
}
async function responseJson(response) {
 if(!response.body)throw new Error('Missing OCR acknowledgement');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>RESPONSE_LIMIT)throw new Error('Oversized OCR acknowledgement');chunks.push(value);}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 }catch{await reader.cancel().catch(()=>{});throw new Error('Invalid OCR acknowledgement');}
}
function retryDelay(response,attempt,now) {
 const value=response?.headers.get('retry-after');
 if(value){const seconds=/^\d+(?:\.\d+)?$/.test(value)?Number(value):(Date.parse(value)-now)/1000;if(Number.isFinite(seconds)&&seconds>30)throw new Error('OCR retry exceeds bounded run');if(Number.isFinite(seconds)&&seconds>0)return seconds*1000;}
 return attempt*1000;
}
export async function requestOcr(endpoint,secret,value,{fetcher=fetch,sleep=delay,now=Date.now}={}) {
 const url=validateEndpoint(endpoint),signed=signedRequest(value,secret,String(now()));
 for(let attempt=1;attempt<=3;attempt++){
  let response;
  try{response=await fetcher(url,{method:'POST',redirect:'manual',...signed,signal:AbortSignal.timeout(20_000)});}
  catch{if(attempt===3)throw new Error('OCR transport failed after bounded retries');await sleep(retryDelay(undefined,attempt,now()));continue;}
  if(response.status===200){const data=await responseJson(response);if(typeof data?.cached!=='boolean'||(value.action==='store'&&data.accepted!==true))throw new Error('Invalid OCR acknowledgement');return data;}
  await response.body?.cancel().catch(()=>{});
  if(response.status!==429&&response.status<500)throw new Error(`OCR ingress rejected (HTTP ${response.status})`);
  if(attempt===3)throw new Error(`OCR ingress unavailable (HTTP ${response.status})`);
  await sleep(retryDelay(response,attempt,now()));
 }
}
function paths(index,mime) {
 const directory=`week-${index}`;
 return {imageFile:`${directory}/source.${mime==='image/png'?'png':'jpg'}`,sourceFile:`${directory}/source.json`,resultDirectory:`${directory}/ocr`};
}
function capture(source,imageHash) {return {source,imageHash,version:OCR_VERSION};}
export async function prepare(output,{cache=false,endpoint,secret,discover=discoverMealSources,loadImage=fetchImage,request=requestOcr}={}) {
 if(cache){validateEndpoint(endpoint);signedRequest({},secret);}
 await mkdir(dirname(output),{recursive:true});await mkdir(output,{recursive:false});
 const sources=await discover();
 if(!Array.isArray(sources)||sources.length>2)throw new Error('Unexpected retained source count');
 const entries=[];
 for(const [index,source] of sources.entries()){
  const image=await loadImage(source.imageUrl);
  if(!['image/png','image/jpeg'].includes(image.mime)||image.bytes.length>5*1024*1024||hash(image.bytes)!==image.hash)throw new Error('Invalid downloaded OCR source');
  const names=paths(index,image.mime);await mkdir(join(output,`week-${index}`));
  await writeFile(join(output,names.imageFile),image.bytes,{flag:'wx'});await writeJson(join(output,names.sourceFile),source);
  // The live cache can only be consulted after verifying the actual image identity.
  const cached=cache?(await request(endpoint,secret,{action:'lookup',...capture(source,image.hash)})).cached:false;
  if(typeof cached!=='boolean')throw new Error('Invalid OCR cache acknowledgement');
  entries.push({source,imageHash:image.hash,mime:image.mime,...names,cached});
 }
 const manifest={version:OCR_VERSION,entries};await writeJson(join(output,'manifest.json'),manifest);return manifest;
}
export async function readManifest(output) {
 const bytes=await readFile(join(output,'manifest.json'));if(bytes.length>32*1024)throw new Error('OCR manifest too large');
 const value=JSON.parse(bytes.toString('utf8'));
 if(value?.version!==OCR_VERSION||!Array.isArray(value.entries)||value.entries.length>2)throw new Error('Invalid OCR manifest');
 for(const [index,entry] of value.entries.entries()){
  if(!entry||typeof entry.cached!=='boolean'||!['image/png','image/jpeg'].includes(entry.mime)||!/^[a-f0-9]{64}$/.test(entry.imageHash)||!entry.source||typeof entry.source!=='object')throw new Error('Invalid OCR manifest entry');
  const expected=paths(index,entry.mime);
  if(Object.entries(expected).some(([key,name])=>entry[key]!==name))throw new Error('Invalid OCR manifest paths');
  const sourceBytes=await readFile(join(output,expected.sourceFile));if(sourceBytes.length>8192||JSON.stringify(JSON.parse(sourceBytes.toString('utf8')))!==JSON.stringify(entry.source))throw new Error('OCR source metadata changed');
 }
 return value;
}
export async function ingest(output,{endpoint,secret,request=requestOcr}={}) {
 validateEndpoint(endpoint);signedRequest({},secret);
 const manifest=await readManifest(output);let accepted=0,cached=0;
 for(const [index,entry] of manifest.entries.entries()){
  if(entry.cached){cached++;continue;}
  const names=paths(index,entry.mime),image=await readFile(join(output,names.imageFile));
  if(image.length>5*1024*1024||hash(image)!==entry.imageHash)throw new Error('OCR source bytes changed');
  const bytes=await readFile(join(output,names.resultDirectory,'result.json'));if(bytes.length>BODY_LIMIT)throw new Error('OCR result too large');
  const result=JSON.parse(bytes.toString('utf8'));
  if(result?.version!==OCR_VERSION||result.imageHash!==entry.imageHash||!['paddle','easy'].includes(result.engine))throw new Error('OCR result identity changed');
  const identity=result.identity;
  if(!identity||!Array.isArray(identity.banner)||!Array.isArray(identity.headers)||identity.headers.length!==7||[identity.banner,...identity.headers].some(lines=>!Array.isArray(lines)||!lines.length||lines.length>12||lines.some(line=>typeof line!=='string'||!line.trim()||line.length>150)))throw new Error('Invalid OCR observations');
  // The scoped Worker endpoint independently verifies the observed date text.
  const meal=validateMeal(result.meal,entry.source);
  await request(endpoint,secret,{action:'store',...capture(entry.source,entry.imageHash),engine:result.engine,identity:result.identity,meal});accepted++;
 }
 return {accepted,cached};
}
export async function main(args=process.argv.slice(2),env=process.env) {
 const [command,...flags]=args;const cache=flags.includes('--cache');const at=flags.indexOf('--output');
 if(!['prepare','ingest'].includes(command)||at<0||!flags[at+1]||flags.some((flag,index)=>index!==at+1&&!['--output','--cache'].includes(flag))||flags.filter(x=>x==='--output').length!==1||flags.filter(x=>x==='--cache').length>1||(command==='ingest'&&cache))throw new Error('Usage: collect.mjs prepare|ingest --output DIRECTORY [--cache]');
 const output=resolve(flags[at+1]);validateCollectorLaunch(env);
 const options={cache,endpoint:env.MEAL_OCR_INGEST_URL,secret:env.MEAL_OCR_INGEST_SECRET};
 const result=command==='prepare'?await prepare(output,options):await ingest(output,options);
 console.log(command==='prepare'?`OCR sources prepared: ${result.entries.length}; cached: ${result.entries.filter(e=>e.cached).length}`:`OCR results accepted: ${result.accepted}; cached: ${result.cached}`);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().catch(()=>{console.error('OCR collection/ingestion failed; check bounded diagnostics and configuration. No secrets or upstream bodies are logged.');process.exitCode=1;});
}
