import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {consume,executeJob,mealCommandResponse} from '../src/jobs';
import {addDays} from '../src/time';
import {enqueue} from '../src/storage';
import {fetchImage} from '../src/sources';
vi.mock('../src/sources',async original=>({...await original<object>(),fetchImage:vi.fn()}));
let db:ReturnType<typeof testDatabase>;
const source='https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660';
const image='https://scc.sogang.ac.kr/dataview/board/1185/20261008_0923_5910001.jpg';
const picture={bytes:new Uint8Array([137,80,78,71,13,10,26,10]),mime:'image/png',hash:'fixture'};
beforeEach(()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));db=testDatabase();
 db.sqlite.prepare('INSERT INTO meal_sources VALUES(?,?,?,?,?,?)').run(source,image,'2026-10-08','2026-10-12','2026-10-18',new Date().toISOString());
 vi.mocked(fetchImage).mockReset().mockResolvedValue(picture);
});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.useRealTimers();});
async function command(date='2026-10-14',expires=Date.now()+900000){
 await enqueue(db.env,'file-reply','interaction',{interaction:{id:'file-reply',application_id:'777',token:'fixture-secret',guild_id:'111',type:2,member:{permissions:'0'},data:{name:'meal',options:[{name:'date',value:date}]}},expires});
}
const run=()=>consume(db.env,{messages:[{body:{id:'file-reply'},ack:vi.fn()}]} as any);
const job=()=>db.sqlite.prepare("SELECT state,payload,attempts FROM jobs WHERE id='file-reply'").get()!;
describe('official meal file replies',()=>{
 it('explains download failure instead of claiming an image was attached',async()=>{
  vi.mocked(fetchImage).mockRejectedValueOnce(new Error('private upstream detail'));
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));await command();await run();
  const body=JSON.parse(send.mock.calls[0][1]!.body as string);
  expect(body.content).toContain('이미지 파일을 불러오지 못했습니다');expect(body.content).toContain(source);expect(body.content).not.toContain('private upstream detail');
  expect(body.attachments).toEqual([]);expect(body).not.toHaveProperty('embeds');expect(job().state).toBe('done');
 });
 it('replaces the attachment set on a retried original-message PATCH',async()=>{
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:503})).mockResolvedValueOnce(new Response('{}'));
  await command();await run();expect(job().state).toBe('retry');expect(job().payload).toContain('fixture-secret');
  vi.advanceTimersByTime(30000);await run();expect(job().state).toBe('done');expect(job().payload).toBe('{}');expect(send).toHaveBeenCalledTimes(2);
  for(const [,request] of send.mock.calls){
   expect(request!.method).toBe('PATCH');expect(request!.headers).toBeUndefined();
   const form=request!.body as FormData,body=JSON.parse(form.get('payload_json') as string);
   expect(body.attachments).toEqual([{id:0,filename:'bellarmino-2026-10-12-2026-10-18.png'}]);expect(body.allowed_mentions.parse).toEqual([]);
   expect(await (form.get('files[0]') as File).arrayBuffer()).toEqual(picture.bytes.buffer);
  }
 });
 it('clears previous files when a lost-response image PATCH is retried with usable text',async()=>{
  const send=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new Error('lost webhook response')).mockResolvedValueOnce(new Response('{}'));
  await command();await run();expect(job().state).toBe('retry');
  const first=send.mock.calls[0][1]!,form=first.body as FormData;
  expect(first.method).toBe('PATCH');expect(form).toBeInstanceOf(FormData);
  expect(JSON.parse(String(form.get('payload_json'))).attachments).toEqual([{id:0,filename:'bellarmino-2026-10-12-2026-10-18.png'}]);
  expect(form.get('files[0]')).toBeInstanceOf(File);
  cacheWeek(true);vi.advanceTimersByTime(30000);await run();
  expect(send).toHaveBeenCalledTimes(2);expect(job().state).toBe('done');expect(job().payload).toBe('{}');
  const second=send.mock.calls[1][1]!,body=JSON.parse(second.body as string);
  expect(second.method).toBe('PATCH');expect(new Headers(second.headers).get('content-type')).toBe('application/json');
  expect(typeof second.body).toBe('string');expect(body.content).toContain('fixture menu');expect(body.attachments).toEqual([]);expect(body.allowed_mentions.parse).toEqual([]);
  expect(fetchImage).toHaveBeenCalledTimes(1);
 });
 it('does not upload an image whose week expires during download',async()=>{
  vi.setSystemTime(new Date('2026-10-18T14:59:30Z'));
  vi.mocked(fetchImage).mockImplementationOnce(async()=>{vi.advanceTimersByTime(120000);return picture;});
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));await command('2026-10-18');await run();
  const body=JSON.parse(send.mock.calls[0][1]!.body as string);expect(body.content).toContain('식단 확인 불가 (2026-10-18)');expect(body.attachments).toEqual([]);
 });
 it('does not send to an interaction which expires during download',async()=>{
  vi.mocked(fetchImage).mockImplementationOnce(async()=>{vi.advanceTimersByTime(20000);return picture;});
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));await command('2026-10-14',Date.now()+10000);await run();
  expect(send).not.toHaveBeenCalled();expect(job().state).toBe('needs_review');expect(job().attempts).toBe(1);
 });
 it.each(['2026-02-30','2026-10-11','2026-10-26'])('does not download an invalid/out-of-window image for %s',async date=>{
  expect(typeof await mealCommandResponse(db.env,date)).toBe('string');expect(fetchImage).not.toHaveBeenCalled();
 });
});

async function daily(date='2026-10-14',guild='111'){
 db.env.DISCORD_TOKEN='fixture-only';
 db.sqlite.prepare('INSERT INTO guilds(id,meals_channel,updated_at) VALUES(?,?,?)').run(guild,'1001',new Date().toISOString());
 await executeJob(db.env,{id:`meal-daily:${date}`,kind:'meal-daily',payload:JSON.stringify({date}),state:'running',attempts:1,created_at:new Date().toISOString(),lease_until:null});
 return `meal:${guild}:${date}`;
}
const deliver=(id:string)=>consume(db.env,{messages:[{body:{id:`send:${id}`},ack:vi.fn()}]} as any);
const delivery=(id:string)=>db.sqlite.prepare('SELECT * FROM deliveries WHERE id=?').get(id)!;
const deliveryJob=(id:string)=>db.sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(`send:${id}`)!;
function cacheWeek(usable=false){
 const unknown=()=>({status:'unknown',items:[],time:null,evidence:''});
 const week={start:'2026-10-12',end:'2026-10-18',certain:true,days:Array.from({length:7},(_,i)=>({date:addDays('2026-10-12',i),weekday:i+1,breakfastKorean:unknown(),breakfastWestern:unknown(),breakfastCommon:unknown(),cupRice:unknown(),dinner:unknown(),drinks:unknown()}))};
 if(usable)week.days[2].breakfastKorean={status:'available',items:['fixture menu'],time:null,evidence:'fixture'};
 db.sqlite.prepare('INSERT INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)').run('scheduled-week',source,'hash','version',week.start,week.end,JSON.stringify(week),new Date().toISOString(),new Date().toISOString(),'fixture/model:free');
}
describe('scheduled official meal image fallback',()=>{
 it.each([['missing','image/png'],['unknown','image/png'],['missing','image/jpeg']])('uploads an official file when extraction is %s (%s)',async(cache,mime)=>{
  if(cache==='unknown')cacheWeek();
  const bytes=mime==='image/png'?picture.bytes:new Uint8Array([255,216,255,217]);
  vi.mocked(fetchImage).mockResolvedValueOnce({bytes,mime,hash:'fixture'});
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));
  const id=await daily();
  expect(JSON.parse(String(deliveryJob(id).payload))).toEqual({deliveryId:id,mealDate:'2026-10-14'});
  expect(fetchImage).not.toHaveBeenCalled();await deliver(id);
  expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toContain('/channels/1001/messages');
  const request=send.mock.calls[0][1]!,headers=new Headers(request.headers),form=request.body as FormData;
  expect(request.method).toBe('POST');expect(headers.get('authorization')).toBe('Bot fixture-only');expect(headers.has('content-type')).toBe(false);expect(form).toBeInstanceOf(FormData);
  const payload=JSON.parse(String(form.get('payload_json'))),file=form.get('files[0]') as File;
  const filename=`bellarmino-2026-10-12-2026-10-18.${mime==='image/png'?'png':'jpg'}`;
  expect(payload.attachments).toEqual([{id:0,filename}]);expect(payload.allowed_mentions.parse).toEqual([]);expect(payload.content).toContain('2026-10-14');expect(payload.content).toContain(source);expect(payload).not.toHaveProperty('embeds');
  expect(file.name).toBe(filename);expect(file.type).toBe(mime);expect(await file.arrayBuffer()).toEqual(bytes.buffer);expect(fetchImage).toHaveBeenCalledWith(image);
  expect(delivery(id)).toMatchObject({state:'sent',message_id:'9001'});expect(deliveryJob(id).state).toBe('done');
  expect(db.sqlite.prepare('SELECT COUNT(*) n FROM llm_usage').get()!.n).toBe(0);expect(db.sqlite.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='meal-extract'").get()!.n).toBe(0);
 });
 it('keeps usable extracted meals text-only',async()=>{
  cacheWeek(true);const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));
  const id=await daily();await deliver(id);
  const payload=JSON.parse(send.mock.calls[0][1]!.body as string);expect(payload.content).toContain('fixture menu');expect(payload).not.toHaveProperty('attachments');expect(fetchImage).not.toHaveBeenCalled();expect(delivery(id).state).toBe('sent');
 });
 it.each(['absent','expired'])('keeps %s source metadata link-only',async(kind)=>{
  if(kind==='absent')db.sqlite.exec('DELETE FROM meal_sources');else db.sqlite.prepare('UPDATE meal_sources SET start_date=?,end_date=?').run('2026-10-05','2026-10-11');
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));const id=await daily();await deliver(id);
  const payload=JSON.parse(send.mock.calls[0][1]!.body as string);expect(payload.content).toContain('식단 확인 불가 (2026-10-14)');expect(payload).not.toHaveProperty('attachments');expect(fetchImage).not.toHaveBeenCalled();
 });
 it('explains an image download failure without claiming attachment or leaking the error',async()=>{
  vi.mocked(fetchImage).mockRejectedValueOnce(new Error('private upstream detail'));
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));const id=await daily();await deliver(id);
  const payload=JSON.parse(send.mock.calls[0][1]!.body as string);expect(payload.content).toContain('이미지 파일을 불러오지 못했습니다');expect(payload.content).toContain(source);expect(payload.content).not.toContain('private upstream detail');expect(payload).not.toHaveProperty('attachments');expect(delivery(id).state).toBe('sent');
 });
 it('expires a daily delivery which crosses KST midnight during image download',async()=>{
  vi.setSystemTime(new Date('2026-10-18T14:59:30Z'));
  vi.mocked(fetchImage).mockImplementationOnce(async()=>{vi.advanceTimersByTime(120000);return picture;});
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));const id=await daily('2026-10-18');await deliver(id);
  expect(send).not.toHaveBeenCalled();expect(delivery(id).state).toBe('expired');expect(deliveryJob(id).state).toBe('done');
 });
 it.each(['network','503','408','malformed success'])('never replays an uncertain multipart POST (%s)',async(outcome)=>{
  const send=vi.spyOn(globalThis,'fetch');
  if(outcome==='network')send.mockRejectedValue(new Error('interrupted'));else send.mockResolvedValue(outcome==='malformed success'?new Response('not json'):new Response('{}',{status:Number(outcome)}));
  const id=await daily();await deliver(id);expect(delivery(id).state).toBe('uncertain');expect(deliveryJob(id).state).toBe('done');
  await deliver(id);await executeJob(db.env,deliveryJob(id) as any);
  expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][1]!.body).toBeInstanceOf(FormData);expect(fetchImage).toHaveBeenCalledTimes(1);
 });
 it('rebuilds the multipart file on a safe confirmed 429 retry',async()=>{
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({retry_after:10},{status:429})).mockResolvedValueOnce(Response.json({id:'9001',channel_id:'1001'}));
  const id=await daily();await deliver(id);expect(delivery(id).state).toBe('retry');expect(deliveryJob(id).state).toBe('retry');
  vi.advanceTimersByTime(10000);await deliver(id);expect(delivery(id).state).toBe('sent');expect(deliveryJob(id).state).toBe('done');expect(send).toHaveBeenCalledTimes(2);expect(fetchImage).toHaveBeenCalledTimes(2);
  for(const [,request] of send.mock.calls){const form=request!.body as FormData;expect(form).toBeInstanceOf(FormData);expect(JSON.parse(String(form.get('payload_json'))).attachments).toEqual([{id:0,filename:'bellarmino-2026-10-12-2026-10-18.png'}]);expect(await (form.get('files[0]') as File).arrayBuffer()).toEqual(picture.bytes.buffer);}
 });
 it('does not download or post to a disabled guild',async()=>{
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));const id=await daily();db.env.ALLOWED_GUILDS='222';await deliver(id);
  expect(fetchImage).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(delivery(id).state).toBe('failed');
 });
 it('claims overlapping consumers once before image download and channel POST',async()=>{
  const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:'9001',channel_id:'1001'}));const id=await daily();
  await Promise.all([deliver(id),deliver(id)]);expect(fetchImage).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);expect(delivery(id).state).toBe('sent');expect(deliveryJob(id).attempts).toBe(1);
 });
});
