import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateEndpoint,signedRequest,requestOcr,prepare,readManifest,ingest} from './collect.mjs';

const endpoint='https://bot.example/internal/meal-ocr',secret='x'.repeat(32);
const source={url:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660',imageUrl:'https://scc.sogang.ac.kr/dataview/board/1185/test.png',published:'2026-10-08',start:'2026-10-12',end:'2026-10-18'};
const bytes=Buffer.from([137,80,78,71,13,10,26,10]),image={bytes,mime:'image/png',hash:createHash('sha256').update(bytes).digest('hex')};
const capture={action:'lookup',source,imageHash:image.hash,version:'ocr-v1'};
async function temporary(fn){const root=await mkdtemp(join(tmpdir(),'meal-ocr-client-'));try{await fn(join(root,'output'));}finally{await rm(root,{recursive:true,force:true});}}

test('endpoint and signing have the scoped canonical contract',()=>{
 assert.equal(validateEndpoint(endpoint),endpoint);
 for(const value of ['http://bot.example/internal/meal-ocr',endpoint+'?a=1',endpoint+'#x','https://u:p@bot.example/internal/meal-ocr','https://bot.example/internal/notices',' '+endpoint])assert.throws(()=>validateEndpoint(value));
 const timestamp='1791849600000',signed=signedRequest(capture,secret,timestamp);
 assert.equal(signed.headers['x-collector-signature'],createHmac('sha256',secret).update(`${timestamp}.${signed.body}`).digest('hex'));
 assert.throws(()=>signedRequest(capture,'short'));
 assert.throws(()=>signedRequest({value:'x'.repeat(256*1024)},secret));
});
test('transport retries preserve idempotent signed body and refuse redirect/auth errors',async()=>{
 let calls=0;const requests=[];
 const result=await requestOcr(endpoint,secret,capture,{sleep:async()=>{},fetcher:async(url,options)=>{requests.push(options);if(++calls===1)throw new Error('private upstream body');if(calls===2)return new Response('private',{status:503});return Response.json({cached:true});}});
 assert.deepEqual(result,{cached:true});assert.equal(calls,3);assert.equal(requests[0].body,requests[2].body);assert.equal(requests[0].redirect,'manual');
 for(const status of [302,401,409]){let count=0;await assert.rejects(requestOcr(endpoint,secret,capture,{fetcher:async()=>{count++;return new Response('sensitive',{status});}}),new RegExp(`HTTP ${status}`));assert.equal(count,1);}
});
test('bounded acknowledgement and Retry-After cannot trigger unbounded response or wait',async()=>{
 await assert.rejects(requestOcr(endpoint,secret,capture,{fetcher:async()=>new Response('x'.repeat(8193))}),/Invalid OCR acknowledgement/);
 await assert.rejects(requestOcr(endpoint,secret,capture,{fetcher:async()=>Response.json({accepted:true})}),/Invalid OCR acknowledgement/);
 await assert.rejects(requestOcr(endpoint,secret,capture,{fetcher:async()=>new Response('',{status:503,headers:{'retry-after':'60'}})}),/bounded run/);
});
test('prepare is upload-free by default; explicit cache lookup follows download/hash verification',async()=>temporary(async output=>{
 const order=[];const manifest=await prepare(output,{discover:async()=>[source],loadImage:async()=>{order.push('download');return image;},request:async()=>{throw new Error('must not call');}});
 assert.equal(manifest.entries[0].cached,false);assert.deepEqual(order,['download']);
 assert.deepEqual(await readManifest(output),manifest);
 await assert.rejects(prepare(output,{discover:async()=>[]}),/EEXIST/);
 await assert.rejects(ingest(output,{endpoint,secret,request:async()=>{throw new Error('must not call');}}),/ENOENT/);
}));
test('cache capture is explicit and rejects errors instead of fabricating cached results',async()=>temporary(async output=>{
 const order=[];const manifest=await prepare(output,{cache:true,endpoint,secret,discover:async()=>[source],loadImage:async()=>{order.push('download');return image;},request:async(_endpoint,_secret,body)=>{order.push('lookup');assert.deepEqual(body,capture);return {cached:true};}});
 assert.deepEqual(order,['download','lookup']);assert.equal(manifest.entries[0].cached,true);
 const result=await ingest(output,{endpoint,secret,request:async()=>{throw new Error('must not upload cached');}});
 assert.deepEqual(result,{accepted:0,cached:1});
}));
test('manifest paths and source metadata cannot redirect ingestion to another result',async()=>temporary(async output=>{
 const manifest=await prepare(output,{discover:async()=>[source],loadImage:async()=>image});
 manifest.entries[0].resultDirectory='../untrusted';await writeFile(join(output,'manifest.json'),JSON.stringify(manifest));
 await assert.rejects(readManifest(output),/manifest paths/);
}));
test('ingestion sends only matching validated result fields, with bounded observations',async()=>temporary(async output=>{
 await prepare(output,{discover:async()=>[source],loadImage:async()=>image});await mkdir(join(output,'week-0','ocr'));
 const unknown={status:'unknown',items:[],time:null,evidence:''};
 const dates=Array.from({length:7},(_,i)=>`2026-10-${12+i}`),weekdays=['월','화','수','목','금','토','일'];
 const meal={start:source.start,end:source.end,certain:true,days:dates.map((date,i)=>({date,weekday:i+1,breakfastKorean:unknown,breakfastWestern:unknown,breakfastCommon:unknown,cupRice:unknown,dinner:unknown,drinks:unknown}))};
 const identity={banner:['2026.10.12~10.18'],headers:dates.map((date,i)=>[`10월 ${date.slice(-2)}일`,`${weekdays[i]}요일`])};
 const result={version:'ocr-v1',imageHash:image.hash,engine:'paddle',identity,meal};
 const path=join(output,'week-0','ocr','result.json');await writeFile(path,JSON.stringify(result));
 let calls=0;const request=async(_endpoint,_secret,body)=>{calls++;assert.deepEqual(body,{...capture,action:'store',engine:'paddle',identity,meal});return {accepted:true,cached:false};};
 assert.deepEqual(await ingest(output,{endpoint,secret,request}),{accepted:1,cached:0});
 result.imageHash='0'.repeat(64);await writeFile(path,JSON.stringify(result));await assert.rejects(ingest(output,{endpoint,secret,request}),/identity changed/);assert.equal(calls,1);
 result.imageHash=image.hash;result.identity.headers[0]=[];await writeFile(path,JSON.stringify(result));await assert.rejects(ingest(output,{endpoint,secret,request}),/observations/);assert.equal(calls,1);
}));
test('downloaded bytes must match the claimed content hash before cache lookup',async()=>temporary(async output=>{
 let calls=0;await assert.rejects(prepare(output,{cache:true,endpoint,secret,discover:async()=>[source],loadImage:async()=>({...image,hash:'0'.repeat(64)}),request:async()=>{calls++;}}),/downloaded OCR source/);assert.equal(calls,0);
}));
