import {afterEach, describe, expect, it, vi} from 'vitest';
import {testDatabase} from './helpers/db';
import worker, {handleRequest, completeInteraction} from '../src/worker';
import {consume} from '../src/jobs';
import {enqueue, recover, saveNotices} from '../src/storage';
import {MealExtractionError,validateMeal} from '../src/meals';
import {addDays,todayKst} from '../src/time';
vi.mock('../src/meals',async importOriginal=>({...await importOriginal<object>(),extractMeal:vi.fn()}));
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
describe('interaction and durable integration',()=>{
 it('records Cron planning and creates first collection jobs without awaiting a six-hour interval',async()=>{
  const db=testDatabase();try {
   const event={scheduledTime:Date.parse('2026-10-09T14:45:00Z')} as ScheduledController;
   await worker.scheduled(event,db.env);
   const health=db.sqlite.prepare("SELECT last_attempt,last_success,error FROM health WHERE id='cron'").get()!;
   expect(health.last_attempt).toBeTruthy();expect(health.last_success).toBeTruthy();expect(health.error).toBeNull();
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='collect'").get()!.n).toBe(6);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='meal-discover'").get()!.n).toBe(1);
   expect(db.env.JOBS.send).toHaveBeenCalledTimes(7);
   await worker.scheduled(event,db.env);
   expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n).toBe(7);
  } finally {db.close();}
 });
 it('discovers meals while disabled without blocking a later enabled extraction',async()=>{
  const db=testDatabase();try {
   vi.spyOn(await import('../src/sources'),'discoverMeal').mockResolvedValue({url:'https://scc.sogang.ac.kr/front/cmsboardview.do?pkid=123',imageUrl:'https://scc.sogang.ac.kr/dataview/board/1185/synthetic.jpg',published:'2026-10-08',start:'2026-10-12',end:'2026-10-18'});
   await enqueue(db.env,'discovery-disabled','meal-discover',{});
   await consume(db.env,{messages:[{body:{id:'discovery-disabled'},ack:vi.fn()}]} as any);
   expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='meal-extract'").get()!.n).toBe(0);
   expect(db.sqlite.prepare("SELECT last_success FROM health WHERE id='meal-discovery'").get()!.last_success).toBeTruthy();
   db.env.LLM_ENABLED='true';db.env.OPENROUTER_API_KEY='fixture';
   await enqueue(db.env,'discovery-enabled','meal-discover',{});
   await consume(db.env,{messages:[{body:{id:'discovery-enabled'},ack:vi.fn()}]} as any);
   expect(db.sqlite.prepare("SELECT state FROM jobs WHERE kind='meal-extract'").get()!.state).toBe('pending');
  } finally {db.close();}
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
 const payload=String(db.sqlite.prepare('SELECT payload FROM jobs').get()!.payload);
 expect(payload).toContain('secret-webhook');expect(payload).not.toContain('private-user');
 }finally{db.close();}});
 it('status is guild scoped and webhook edit disables mentions',async()=>{
 const db=testDatabase();try{
 db.sqlite.exec("INSERT INTO guilds(id,notices_channel,updated_at) VALUES('111','1111','now'),('222','2222','now')");
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 await completeInteraction(db.env,{id:'x',kind:'interaction',payload:JSON.stringify({interaction:interaction('status'),expires:Date.now()+5000})} as any);
 const body=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
 expect(body.content).toContain('1111');expect(body.content).not.toContain('2222');expect(body.allowed_mentions.parse).toEqual([]);
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
 const extraction=vi.mocked((await import('../src/meals')).extractMeal);extraction.mockClear();
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 expect(await (await handleRequest(await signed(db.env,data),db.env)).json()).toEqual({type:5,data:{}});
 const job=db.sqlite.prepare("SELECT * FROM jobs WHERE id='interaction:123'").get()!;
 await completeInteraction(db.env,job as any);
 expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0][1]!.method).toBe('PATCH');
 const body=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
 expect(body.content).toContain(`${date??todayKst()} 벨라르미노 식단`);
 if(!date)expect(body.content).toContain('2026-10-14 벨라르미노 식단');
 expect(body.content).toContain('조식 한식: 확인 불가 / 미기재');expect(body.content).toContain(`원문: <${source}>`);
 expect(body.allowed_mentions.parse).toEqual([]);expect(extraction).not.toHaveBeenCalled();
 }finally{db.close();vi.useRealTimers();}});
 it.each(['2026-02-30','not-a-date','2026-10-1'])('rejects invalid meal date %s without inference or a database lookup',async(date)=>{
 const db=testDatabase();try{
 const extraction=vi.mocked((await import('../src/meals')).extractMeal);extraction.mockClear();
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 const prepared=vi.spyOn(db.env.DB,'prepare');
 await completeInteraction(db.env,{payload:JSON.stringify({interaction:{...interaction('meal'),data:{name:'meal',options:[{name:'date',value:date}]}},expires:Date.now()+5000})} as any);
 expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).content).toContain('날짜를 YYYY-MM-DD 형식으로 입력하세요.');
 expect(prepared).not.toHaveBeenCalled();expect(extraction).not.toHaveBeenCalled();expect(fetchMock).toHaveBeenCalledTimes(1);
 }finally{db.close();}});
 it('returns the discovered source when the default KST meal date is not cached, without inference',async()=>{
 const db=testDatabase();try{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T15:30:00Z'));
 const source='https://scc.sogang.ac.kr/front/cmsboardview.do?pkid=941660';
 db.sqlite.prepare("INSERT INTO health(id,source_url) VALUES('meal-discovery',?)").run(source);
 const extraction=vi.mocked((await import('../src/meals')).extractMeal);extraction.mockClear();
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 await completeInteraction(db.env,{payload:JSON.stringify({interaction:interaction('meal'),expires:Date.now()+5000})} as any);
 expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).content).toBe(`식단 확인 불가 (2026-10-14)\n${source}`);
 expect(extraction).not.toHaveBeenCalled();expect(fetchMock).toHaveBeenCalledTimes(1);
 }finally{db.close();vi.useRealTimers();}});
 it('status counts one active run but retains both released historical reservations',async()=>{
 const db=testDatabase();try{
 const day=todayKst();const insert=db.sqlite.prepare('INSERT INTO llm_usage(id,day,reserved_usd,state,created_at) VALUES(?,?,?,?,?)');
 insert.run('released-31',day,0,'confirmed_rejected','now');insert.run('released-26',day,0,'confirmed_rejected','now');insert.run('active-run',day,0.25,'safe_retry','now');
 const before=db.sqlite.prepare('SELECT * FROM llm_usage ORDER BY id').all();
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
 await completeInteraction(db.env,{payload:JSON.stringify({interaction:interaction('status'),expires:Date.now()+5000})} as any);
 const content=JSON.parse(fetchMock.mock.calls[0][1]!.body as string).content as string;
 expect(content).toContain('LLM 오늘: {"runs":1,"reserved":0.25,"actual":null}');
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
 it('records supplied cost even for rejected meal content without retrying ambiguous inference',async()=>{
 const db=testDatabase();try{
 db.env.LLM_ENABLED='true';db.env.OPENROUTER_API_KEY='test';
 const {extractMeal}=await import('../src/meals');vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('rejected',0.04));
 await enqueue(db.env,'meal-job','meal-extract',{imageUrl:'fixture',hash:'hash'});
 const ack=vi.fn();await consume(db.env,{messages:[{body:{id:'meal-job'},ack}],queue:'test'} as any);
 expect(db.sqlite.prepare('SELECT actual_usd FROM llm_usage').get()!.actual_usd).toBe(0.04);
 expect(db.sqlite.prepare('SELECT state FROM jobs').get()!.state).toBe('needs_review');expect(ack).toHaveBeenCalled();
 }finally{db.close();}});
 it('confirmed OpenRouter 429 can retry after delay while retaining one reservation',async()=>{
 const db=testDatabase();try{
 db.env.LLM_ENABLED='true';db.env.OPENROUTER_API_KEY='test';
 const {extractMeal}=await import('../src/meals');vi.mocked(extractMeal).mockRejectedValue(new MealExtractionError('429',null,true,120));
 await enqueue(db.env,'rate-job','meal-extract',{imageUrl:'fixture',hash:'hash'});
 await consume(db.env,{messages:[{body:{id:'rate-job'},ack:vi.fn()}],queue:'test'} as any);
 expect(db.sqlite.prepare('SELECT state FROM jobs').get()!.state).toBe('retry');
 expect(db.sqlite.prepare('SELECT state FROM llm_usage').get()!.state).toBe('safe_retry');
 expect(db.sqlite.prepare("SELECT error FROM health WHERE id='meal'").get()!.error).toBe('OpenRouter primary attempt 1/5: 429');
 }finally{db.close();}});
});
