import {afterEach, describe, expect, it, vi} from 'vitest';
import {testDatabase} from './helpers/db';
import worker, {handleRequest, completeInteraction} from '../src/worker';
import {consume} from '../src/jobs';
import {dispatch, enqueue, recover, saveNotices} from '../src/storage';
import {validateMeal} from '../src/meals';
import {addDays,todayKst} from '../src/time';
import {SOURCES} from '../src/sources';
vi.mock('../src/sources',async importOriginal=>({...await importOriginal<object>(),fetchImage:vi.fn(async()=>({bytes:new Uint8Array([1]),mime:'image/png',hash:'hash'}))}));
afterEach(()=>vi.restoreAllMocks());
async function signed(env:any,body:any) {
 const key=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
 const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('');
 env.DISCORD_PUBLIC_KEY=hex(await crypto.subtle.exportKey('raw',key.publicKey)); env.DISCORD_APPLICATION_ID='777';
 const text=JSON.stringify(body);const ts=String(Math.floor(Date.now()/1000));
 const signature=hex(await crypto.subtle.sign('Ed25519',key.privateKey,new TextEncoder().encode(ts+text)));
 return new Request('https://bot.test/interactions',{method:'POST',body:text,headers:{'x-signature-ed25519':signature,'x-signature-timestamp':ts}});
}
const interaction=(name:string,guild='111',permissions='32')=>({id:'123',application_id:'777',token:'secret-webhook',type:2,guild_id:guild,member:{permissions,user:{id:'private-user'}},data:{name}});
describe('institution notice channel setup',()=>{
 const channels={university:'1559799050054799433',computing:'1559799078798495805',swedu:'1559799123903909908',convedu:'1559799151942959115',bdata:'1559799178136264754',engineering:'1560465047128514640',psychology:'1560644512672649309',business:'1560644541982445680'};
 function discordApi(rejected?:string,denied?:string){
  return vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
   const url=String(input);
   if(init?.method==='PATCH')return Response.json({});
   if(url.includes('/channels/'))return Response.json({guild_id:url.endsWith('/'+rejected)?'222':'111',type:0,permission_overwrites:url.endsWith('/'+denied)?[{id:'111',type:0,allow:'0',deny:'2048'}]:[]});
   if(url.endsWith('/users/@me'))return Response.json({id:'999'});
   if(url.endsWith('/guilds/111/members/999'))return Response.json({roles:[]});
   if(url.endsWith('/guilds/111/roles'))return Response.json([{id:'111',permissions:'3072'}]);
   throw new Error('Unexpected fixture endpoint');
  });
 }
 const setup=(options:Record<string,string>)=>({...interaction('setup'),data:{name:'setup',options:Object.entries(options).map(([name,value])=>({name,value}))}});
 it('privately configures all eight supplied channels without creating deliveries or changing baselines',async()=>{
  const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture';const api=discordApi();
   await saveNotices(db.env,'university',[],new Date().toISOString());
   const before=db.sqlite.prepare('SELECT * FROM sources').all();
   const response=await handleRequest(await signed(db.env,setup(channels)),db.env);
   expect(await response.json()).toEqual({type:5,data:{flags:64}});
   await completeInteraction(db.env,db.sqlite.prepare("SELECT * FROM jobs WHERE id='interaction:123'").get() as any);
   const guild=db.sqlite.prepare("SELECT * FROM guilds WHERE id='111'").get()!;
   for(const [key,value]of Object.entries(channels))expect(guild[key+'_channel']).toBe(value);
   expect(guild.notices_channel).toBeNull();expect(guild.meals_channel).toBeNull();expect(guild.schedule_channel).toBeNull();
   expect(db.sqlite.prepare('SELECT * FROM sources').all()).toEqual(before);
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(0);
   const patch=api.mock.calls.find(([,init])=>init?.method==='PATCH')!;
   expect(JSON.parse(patch[1]!.body as string)).toMatchObject({allowed_mentions:{parse:[]}});
  }finally{db.close();}
 });
 it('preserves omitted institution, fallback, meal and schedule settings',async()=>{
  const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture';discordApi();
   db.sqlite.exec("INSERT INTO guilds(id,notices_channel,meals_channel,schedule_channel,computing_channel,engineering_channel,updated_at) VALUES('111','100','200','300','400','500','before')");
   await completeInteraction(db.env,{payload:JSON.stringify({interaction:setup({university:channels.university}),expires:Date.now()+60000})} as any);
   expect(db.sqlite.prepare("SELECT * FROM guilds WHERE id='111'").get()).toMatchObject({notices_channel:'100',meals_channel:'200',schedule_channel:'300',computing_channel:'400',engineering_channel:'500',university_channel:channels.university});
  }finally{db.close();}
 });
 it('sets only Engineering while preserving all five existing institution routes and NULL fallback',async()=>{
  const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture';discordApi();
   db.sqlite.exec("INSERT INTO guilds(id,university_channel,computing_channel,swedu_channel,convedu_channel,bdata_channel,updated_at) VALUES('111','101','102','103','104','105','before')");
   await completeInteraction(db.env,{payload:JSON.stringify({interaction:setup({engineering:channels.engineering}),expires:Date.now()+60000})} as any);
   expect(db.sqlite.prepare("SELECT * FROM guilds WHERE id='111'").get()).toMatchObject({notices_channel:null,university_channel:'101',computing_channel:'102',swedu_channel:'103',convedu_channel:'104',bdata_channel:'105',engineering_channel:channels.engineering});
  }finally{db.close();}
 });
 it('sets both department routes without changing existing routes, library or NULL fallback',async()=>{
  const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture';discordApi();
   db.sqlite.exec("INSERT INTO guilds(id,university_channel,computing_channel,swedu_channel,convedu_channel,bdata_channel,engineering_channel,meals_channel,schedule_channel,library_channel,updated_at) VALUES('111','101','102','103','104','105','106','200','300','400','before')");
   await completeInteraction(db.env,{payload:JSON.stringify({interaction:setup({psychology:channels.psychology,business:channels.business}),expires:Date.now()+60000})} as any);
   expect(db.sqlite.prepare("SELECT * FROM guilds WHERE id='111'").get()).toMatchObject({notices_channel:null,university_channel:'101',computing_channel:'102',swedu_channel:'103',convedu_channel:'104',bdata_channel:'105',engineering_channel:'106',meals_channel:'200',schedule_channel:'300',library_channel:'400',psychology_channel:channels.psychology,business_channel:channels.business});
  }finally{db.close();}
 });
 it.each([false,true])('validates every supplied channel before writes (existing guild: %s)',async(existing)=>{
  const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture';const api=discordApi(channels.business);
   if(existing)db.sqlite.exec("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','100','before')");
   const before=db.sqlite.prepare('SELECT * FROM guilds').all();
   await completeInteraction(db.env,{payload:JSON.stringify({interaction:setup(channels),expires:Date.now()+60000})} as any);
   expect(db.sqlite.prepare('SELECT * FROM guilds').all()).toEqual(before);
   const patch=api.mock.calls.find(([,init])=>init?.method==='PATCH')!;
   expect(JSON.parse(patch[1]!.body as string).content).toContain('이 서버에 속한 채널');
  }finally{db.close();}
 });
 it.each(['engineering','psychology','business'] as const)('rejects a %s channel without effective Send Messages permission before writing settings',async(group)=>{
  const db=testDatabase();try{
   db.env.DISCORD_TOKEN='fixture';const api=discordApi(undefined,channels[group]);
   db.sqlite.exec("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','100','before')");
   const before=db.sqlite.prepare('SELECT * FROM guilds').all();
   await completeInteraction(db.env,{payload:JSON.stringify({interaction:setup(channels),expires:Date.now()+60000})} as any);
   expect(db.sqlite.prepare('SELECT * FROM guilds').all()).toEqual(before);
   const patch=api.mock.calls.find(([,init])=>init?.method==='PATCH')!;
   expect(JSON.parse(patch[1]!.body as string).content).toContain('권한');
  }finally{db.close();}
 });
 it.each(['unexpected','toString','__proto__'])('rejects unknown setup option %s without writes',async(key)=>{
  const db=testDatabase();try{
   const api=discordApi();
   await completeInteraction(db.env,{payload:JSON.stringify({interaction:setup({[key]:'123'}),expires:Date.now()+60000})} as any);
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM guilds').get()!.n).toBe(0);
   expect(api).toHaveBeenCalledTimes(1);expect(api.mock.calls[0][1]!.method).toBe('PATCH');
   expect(JSON.parse(api.mock.calls[0][1]!.body as string).content).toBe('잘못된 채널 설정입니다.');
  }finally{db.close();}
 });
});
describe('interaction and durable integration',()=>{
 it('records Cron planning and creates first collection jobs without awaiting a six-hour interval',async()=>{
  const db=testDatabase();try {
   const event={scheduledTime:Date.parse('2026-10-09T14:45:00Z')} as ScheduledController;
   await worker.scheduled(event,db.env);
   const health=db.sqlite.prepare("SELECT last_attempt,last_success,error FROM health WHERE id='cron'").get()!;
   expect(health.last_attempt).toBeTruthy();expect(health.last_success).toBeTruthy();expect(health.error).toBeNull();
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='collect'").get()!.n).toBe(SOURCES.length);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='meal-discover'").get()!.n).toBe(0);
   expect(db.env.JOBS.send).toHaveBeenCalledTimes(SOURCES.length);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind IN ('meal-refresh','schedule-refresh','meal-board','schedule-summary')").get()!.n).toBe(0);
   await worker.scheduled(event,db.env);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(SOURCES.length);
  } finally {db.close();}
 });
 it('discovers source metadata but never plans inference even with stale legacy settings',async()=>{
  const db=testDatabase();try {
   vi.spyOn(await import('../src/sources'),'discoverMealSources').mockResolvedValue([{url:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=123',imageUrl:'https://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg',published:'2026-10-08',start:'2026-10-12',end:'2026-10-18'}]);
   await enqueue(db.env,'discovery-disabled','meal-discover',{});
   await consume(db.env,{messages:[{body:{id:'discovery-disabled'},ack:vi.fn()}]} as any);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='meal-extract'").get()!.n).toBe(0);
   expect(db.sqlite.prepare("SELECT last_success FROM health WHERE id='meal-discovery'").get()!.last_success).toBeTruthy();
   Object.assign(db.env,{LLM_ENABLED:'true',OPENROUTER_API_KEY:'fixture'});
   await enqueue(db.env,'discovery-enabled','meal-discover',{});
   await consume(db.env,{messages:[{body:{id:'discovery-enabled'},ack:vi.fn()}]} as any);
   expect(db.sqlite.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='meal-extract'").get()!.n).toBe(0);
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM llm_usage').get()!.n).toBe(0);
  } finally {db.close();}
 });
 it('captures image metadata without image download or inference in a source-only verification',async()=>{
  const db=testDatabase();try{
   const sources=await import('../src/sources');vi.mocked(sources.fetchImage).mockClear();
   vi.spyOn(sources,'discoverMealSources').mockResolvedValue([{url:'https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=123',imageUrl:'https://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg',published:'2026-10-08',start:'2026-10-12',end:'2026-10-18'}]);
   await enqueue(db.env,'source-only','meal-discover',{sourceOnly:true});
   await consume(db.env,{messages:[{body:{id:'source-only'},ack:vi.fn()}]} as any);
   expect(db.sqlite.prepare('SELECT COUNT(*) n FROM meal_sources').get()!.n).toBe(1);
   expect(db.sqlite.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='meal-extract'").get()!.n).toBe(0);
   expect(sources.fetchImage).not.toHaveBeenCalled();expect(db.sqlite.prepare('SELECT COUNT(*) n FROM llm_usage').get()!.n).toBe(0);
  }finally{db.close();}
 });
 it('retains public source failure details without logging interaction or inference payloads',async()=>{
  const db=testDatabase();try {
   vi.spyOn(console,'error').mockImplementation(()=>{});
   vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:403}));
   await enqueue(db.env,'source-failure','collect',{source:'university'});
   await consume(db.env,{messages:[{body:{id:'source-failure'},ack:vi.fn()}]} as any);
   expect(db.sqlite.prepare("SELECT error FROM jobs WHERE id='source-failure'").get()!.error).toBe('Source HTTP 403');
   expect(db.sqlite.prepare("SELECT error FROM sources WHERE id='university'").get()!.error).toBe('Source HTTP 403');
  } finally {db.close();}
 });
 it('records failed Cron dispatch without claiming successful planning',async()=>{
  const db=testDatabase();try {
   vi.spyOn(console,'error').mockImplementation(()=>{});
   vi.mocked(db.env.JOBS.send).mockRejectedValueOnce(new Error('queue unavailable'));
   await expect(worker.scheduled({scheduledTime:Date.parse('2026-10-09T14:45:00Z')} as ScheduledController,db.env)).rejects.toThrow('queue unavailable');
   const health=db.sqlite.prepare("SELECT last_attempt,last_success,error FROM health WHERE id='cron'").get()!;
   expect(health.last_attempt).toBeTruthy();expect(health.last_success).toBeNull();expect(health.error).toContain('Cron planning failed');
  } finally {db.close();}
 });
 it('rejects bad signatures; responds to signed PING without bot/model keys',async()=>{
 const db=testDatabase();try{
 expect((await handleRequest(new Request('https://bot.test/interactions',{method:'POST',body:'{}'}),db.env)).status).toBe(401);
 expect(await (await handleRequest(await signed(db.env,{type:1}),db.env)).json()).toEqual({type:1});
 }finally{db.close();}});
 it('admin denial and allowlist denial are ephemeral and never enqueue',async()=>{
 const db=testDatabase();try{
 for(const data of [interaction('setup','111','0'),interaction('status','333')]){
 const response=await handleRequest(await signed(db.env,data),db.env);expect((await response.json() as any).data.flags).toBe(64);
 }expect(db.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()!.n).toBe(0);
 }finally{db.close();}});
 it('defers admin work privately, minimizes token data, schedules acknowledgement propagation delay',async()=>{
 const db=testDatabase();try{
 const response=await handleRequest(await signed(db.env,interaction('status')),db.env);
 expect(await response.json()).toEqual({type:5,data:{flags:64}});
 expect(db.env.JOBS.send).toHaveBeenCalledWith({id:'interaction:123'},{delaySeconds:2});
 expect(await (await handleRequest(await signed(db.env,interaction('status')),db.env)).json()).toEqual({type:5,data:{flags:64}});
 expect(db.env.JOBS.send).toHaveBeenCalledTimes(1);
 const payload=String(db.sqlite.prepare('SELECT payload FROM jobs').get()!.payload);
 expect(payload).toContain('secret-webhook');expect(payload).not.toContain('private-user');
 }finally{db.close();}});
 it('enforces persisted propagation delay through Queue consumption, including an early duplicate',async()=>{
 const db=testDatabase();try{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 expect(await (await handleRequest(await signed(db.env,interaction('status')),db.env)).json()).toEqual({type:5,data:{flags:64}});
 expect(db.sqlite.prepare("SELECT available_at FROM jobs WHERE id='interaction:123'").get()!.available_at).toBe('2026-10-16T00:00:02.000Z');
 const batch={messages:[{body:{id:'interaction:123'},ack:vi.fn()}],queue:'test'} as any;
 await consume(db.env,batch);vi.setSystemTime(new Date('2026-10-16T00:00:01.999Z'));
 await dispatch(db.env);await consume(db.env,batch);
 expect(fetchMock).not.toHaveBeenCalled();expect(db.env.JOBS.send).toHaveBeenCalledTimes(1);
 expect(db.sqlite.prepare("SELECT state,attempts FROM jobs WHERE id='interaction:123'").get()).toMatchObject({state:'pending',attempts:0});
 vi.setSystemTime(new Date('2026-10-16T00:00:02Z'));await consume(db.env,batch);
 expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0][1]!.method).toBe('PATCH');
 expect(db.sqlite.prepare("SELECT state,attempts,payload FROM jobs WHERE id='interaction:123'").get()).toMatchObject({state:'done',attempts:1,payload:'{}'});
 }finally{db.close();vi.useRealTimers();}});
 it('status is guild scoped and webhook edit disables mentions',async()=>{
 const db=testDatabase();try{
 db.sqlite.exec("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','1111','now'),('222','2222','now')");
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 await completeInteraction(db.env,{id:'x',kind:'interaction',payload:JSON.stringify({interaction:interaction('status'),expires:Date.now()+5000})} as any);
 const body=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
 expect(body.content).toContain('1111');expect(body.content).not.toContain('2222');expect(body.allowed_mentions.parse).toEqual([]);
 }finally{db.close();}});
 it('includes only the current guild and route library writer diagnostics in status',async()=>{
 const db=testDatabase();try{
 db.sqlite.exec("INSERT INTO guilds(id,library_channel,updated_at) VALUES('111','1001','now'),('222','2002','now'); INSERT INTO library_board_state(guild_id,channel_id,post_state,error,updated_at) VALUES('111','1001','uncertain','current-route-quarantine','now'),('111','1002',NULL,'old-route-private','now'),('222','2002',NULL,'other-guild-private','now')");
 const {operationalStatus}=await import('../src/status');const result=await operationalStatus(db.env,'111');
 const text=typeof result==='string'?result:result.file?new TextDecoder().decode(result.file.bytes):result.content;
 expect(text).toContain('current-route-quarantine');expect(text).toContain('uncertain');expect(text).not.toContain('old-route-private');expect(text).not.toContain('other-guild-private');
 }finally{db.close();}});
 it.each([undefined,'2026-10-12'])('serves the stored validated meal for date %s through a signed deferred interaction without inference',async(date)=>{
 const db=testDatabase();try{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T15:30:00Z'));
 const unknown=()=>({status:'unknown',items:[],time:null,evidence:''});
 const expected={start:'2026-10-12',end:'2026-10-18',published:'2026-10-08'};
 const week=validateMeal({start:expected.start,end:expected.end,certain:true,days:Array.from({length:7},(_,i)=>({date:addDays(expected.start,i),weekday:i+1,breakfastKorean:unknown(),breakfastWestern:unknown(),breakfastCommon:unknown(),cupRice:unknown(),dinner:unknown(),drinks:unknown()}))},expected);
 const source='https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660';
 db.sqlite.prepare('INSERT INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)').run('synthetic-week',source,'fixture-hash','fixture-version',week.start,week.end,JSON.stringify(week),new Date().toISOString(),new Date().toISOString(),'fixture/model:free');
 const data={...interaction('meal','111','0'),data:{name:'meal',...(date?{options:[{name:'date',value:date}]}:{})}};
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 expect(await (await handleRequest(await signed(db.env,data),db.env)).json()).toEqual({type:5,data:{}});
 vi.setSystemTime(Date.now()+2000);
 const job=db.sqlite.prepare("SELECT * FROM jobs WHERE id='interaction:123'").get()!;
 await completeInteraction(db.env,job as any);
 expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0][1]!.method).toBe('PATCH');
 const body=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
 expect(body.content).toContain(`${date??todayKst()} 벨라르미노 식단`);
 if(!date)expect(body.content).toContain('2026-10-14 벨라르미노 식단');
 expect(body.content).toContain('조식 한식: 확인 불가 / 미기재');expect(body.content).toContain(`원문: <${source}>`);
 expect(body.allowed_mentions.parse).toEqual([]);
 }finally{db.close();vi.useRealTimers();}});
 it.each([['missing','image/png'],['unknown','image/png'],['missing','image/jpeg']])('uploads the matching official image file when extraction is %s (%s)',async(cache,mime)=>{
 const db=testDatabase();try{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T15:30:00Z'));
 const source='https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941660';
 const image='https://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg';
 db.sqlite.prepare('INSERT INTO meal_sources(source_url,image_url,published,start_date,end_date,verified_at) VALUES(?,?,?,?,?,?)').run(source,image,'2026-10-08','2026-10-12','2026-10-18',new Date().toISOString());
 if(cache==='unknown'){
  const unknown=()=>({status:'unknown',items:[],time:null,evidence:''});
  const week={start:'2026-10-12',end:'2026-10-18',certain:true,days:Array.from({length:7},(_,i)=>({date:addDays('2026-10-12',i),weekday:i+1,breakfastKorean:unknown(),breakfastWestern:unknown(),breakfastCommon:unknown(),cupRice:unknown(),dinner:unknown(),drinks:unknown()}))};
  db.sqlite.prepare('INSERT INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)').run('unknown-week',source,'hash','version',week.start,week.end,JSON.stringify(week),new Date().toISOString(),new Date().toISOString(),'fixture/model:free');
 }
 const download=vi.mocked((await import('../src/sources')).fetchImage);download.mockClear();download.mockResolvedValueOnce({bytes:new Uint8Array([1,2,3]),mime,hash:'fixture'});
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 expect(await (await handleRequest(await signed(db.env,interaction('meal','111','0')),db.env)).json()).toEqual({type:5,data:{}});
 vi.setSystemTime(Date.now()+2000);
 const job=db.sqlite.prepare("SELECT * FROM jobs WHERE id='interaction:123'").get()!;
 await completeInteraction(db.env,job as any);
 expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0][1]!.method).toBe('PATCH');
 const request=fetchMock.mock.calls[0][1]!,form=request.body as FormData;
 expect(form).toBeInstanceOf(FormData);expect(request.headers).toBeUndefined();
 const body=JSON.parse(form.get('payload_json') as string),file=form.get('files[0]') as File;
 const filename=`bellarmino-2026-10-12-2026-10-18.${mime==='image/png'?'png':'jpg'}`;
 expect(body.content).toContain('2026-10-14');expect(body.content).toContain(`원문: <${source}>`);expect(body.attachments).toEqual([{id:0,filename}]);expect(body).not.toHaveProperty('embeds');expect(body.allowed_mentions.parse).toEqual([]);
 expect(file.name).toBe(filename);expect(file.type).toBe(mime);expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1,2,3]);expect(download).toHaveBeenCalledWith(image);
 expect(body).not.toHaveProperty('flags');expect(db.sqlite.prepare('SELECT COUNT(*) n FROM llm_usage').get()!.n).toBe(0);
 }finally{db.close();vi.useRealTimers();}});
 it.each(['2026-02-30','not-a-date','2026-10-1'])('rejects invalid meal date %s without a database lookup',async(date)=>{
 const db=testDatabase();try{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 const prepared=vi.spyOn(db.env.DB,'prepare');
 await completeInteraction(db.env,{payload:JSON.stringify({interaction:{...interaction('meal'),data:{name:'meal',options:[{name:'date',value:date}]}},expires:Date.now()+5000})} as any);
 const body=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
 expect(body.content).toContain('날짜를 YYYY-MM-DD 형식으로 입력하세요.');expect(body).not.toHaveProperty('embeds');expect(body.allowed_mentions.parse).toEqual([]);
 expect(prepared).not.toHaveBeenCalled();expect(fetchMock).toHaveBeenCalledTimes(1);
 }finally{db.close();}});
 it('returns the discovered source when the default KST meal date is not cached, without inference',async()=>{
 const db=testDatabase();try{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T15:30:00Z'));
 const source='https://scc.sogang.ac.kr/front/cmsboardview.do?pkid=941660';
 db.sqlite.prepare("INSERT INTO health(id,source_url) VALUES('meal-discovery',?)").run(source);
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 await completeInteraction(db.env,{payload:JSON.stringify({interaction:interaction('meal'),expires:Date.now()+5000})} as any);
 expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).content).toBe(`식단 확인 불가 (2026-10-14)\n${source}`);
 expect(fetchMock).toHaveBeenCalledTimes(1);
 }finally{db.close();vi.useRealTimers();}});
 it('does not serve an expired menu or embed its image before physical maintenance',async()=>{
  const db=testDatabase();try{
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T15:30:00Z'));
   const source='https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=941444',image='https://scc.sogang.ac.kr/dataview/board/1185/old.jpg';
   db.sqlite.prepare('INSERT INTO meal_sources(source_url,image_url,published,start_date,end_date,verified_at) VALUES(?,?,?,?,?,?)').run(source,image,'2026-09-30','2026-10-05','2026-10-11','old');
   db.sqlite.prepare('INSERT INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)').run('old',source,'hash','v','2026-10-05','2026-10-11','{"sentinel":"old menu"}','old','old','fixture/model:free');
   const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
   await completeInteraction(db.env,{payload:JSON.stringify({interaction:{...interaction('meal'),data:{name:'meal',options:[{name:'date',value:'2026-10-11'}]}},expires:Date.now()+5000})} as any);
   const body=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);expect(body.content).toContain('식단 확인 불가 (2026-10-11)');expect(body).not.toHaveProperty('embeds');expect(body.content).not.toContain('old menu');
  }finally{db.close();vi.useRealTimers();}
 });
 it('status labels historical reservations and retains both released records',async()=>{
 const db=testDatabase();try{
 const day=todayKst();const insert=db.sqlite.prepare('INSERT INTO llm_usage(id,day,reserved_usd,state,created_at) VALUES(?,?,?,?,?)');
 insert.run('released-31',day,0,'confirmed_rejected','now');insert.run('released-26',day,0,'confirmed_rejected','now');insert.run('active-run',day,0.25,'safe_retry','now');
 const before=db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all();
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 await completeInteraction(db.env,{payload:JSON.stringify({interaction:interaction('status'),expires:Date.now()+5000})} as any);
 const content=JSON.parse(fetchMock.mock.calls[0][1]!.body as string).content as string;
 expect(content).toContain('과거 LLM 예약(오늘 KST): {"runs":1,"reserved":0.25,"actual":null}');
 expect(db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all()).toEqual(before);
 }finally{db.close();}});
 it('idempotent webhook PATCH retries a transient acknowledgement race and clears tokens only after completion',async()=>{
 const db=testDatabase();try{
 await enqueue(db.env,'interaction:retry','interaction',{interaction:interaction('meal'),expires:Date.now()+50000});
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:404})).mockResolvedValueOnce(new Response('{}'));
 const batch={messages:[{body:{id:'interaction:retry'},ack:vi.fn()}],queue:'test'} as any;
 await consume(db.env,batch);
 let row=db.sqlite.prepare('SELECT state,payload FROM jobs').get()!;
 expect(row.state).toBe('retry');expect(row.payload).toContain('secret-webhook');
 db.sqlite.exec("UPDATE jobs SET available_at='2020-01-01'");
 await consume(db.env,batch);row=db.sqlite.prepare('SELECT state,payload FROM jobs').get()!;
 expect(row.state).toBe('done');expect(row.payload).toBe('{}');expect(fetchMock).toHaveBeenCalledTimes(2);
 }finally{db.close();}});
 it('recovery purges expired and crashed webhook secrets',async()=>{
 const db=testDatabase();try{
 await enqueue(db.env,'old','interaction',{token:'secret'});
 db.sqlite.exec("UPDATE jobs SET state='running',created_at='2020-01-01',lease_until='2020-01-01'");
 await recover(db.env);expect(db.sqlite.prepare('SELECT payload FROM jobs').get()!.payload).toBe('{}');
 }finally{db.close();}});
 it('overlapping source snapshot saves cannot both create new alerts',async()=>{
 const db=testDatabase();try{
 await saveNotices(db.env,'a',[],new Date().toISOString());
 const notice={source:'a',id:'1',title:'new',published:'2026-10-09',url:'https://www.sogang.ac.kr/ko/detail/1'};
 await Promise.allSettled([saveNotices(db.env,'a',[notice],'2026-10-09T00:00:00Z'),saveNotices(db.env,'a',[notice],'2026-10-09T00:00:01Z')]);
 expect(db.sqlite.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='notice-alert'").get()!.n).toBe(1);
 }finally{db.close();}});
});
