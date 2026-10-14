import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {executeJob,planCron,updateMealBoard} from '../src/jobs';
import {updateScheduleSummary} from '../src/schedule-summary';
import {BoardRetry} from '../src/message-board';
import {fetchImage} from '../src/sources';
import {addDays} from '../src/time';
import type {Job,Schedule} from '../src/types';
vi.mock('../src/sources',async original=>({...await original<object>(),fetchImage:vi.fn()}));
let db:ReturnType<typeof testDatabase>;
const unknown=()=>({status:'unknown',items:[],time:null,evidence:''});
const available=(item:string)=>({status:'available',items:[item],time:null,evidence:item});
const state=()=>db.sqlite.prepare("SELECT * FROM meal_messages WHERE guild_id='111' AND channel_id='333'").get()!;
function seed(start='2026-10-12',id='941660',known=true){
 const end=addDays(start,6),url=`https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=${id}`;
 db.sqlite.prepare('INSERT INTO meal_sources VALUES(?,?,?,?,?,?)').run(url,`https://scc.sogang.ac.kr/dataview/board/1185/${id}.png`,start,start,end,new Date().toISOString());
 const week={start,end,certain:true,days:Array.from({length:7},(_,i)=>({date:addDays(start,i),weekday:i+1,breakfastKorean:known?available(`아침-${addDays(start,i)}`):unknown(),breakfastWestern:unknown(),breakfastCommon:unknown(),dinner:known?available(`저녁-${addDays(start,i)}`):unknown(),cupRice:unknown(),drinks:unknown()}))};
 db.sqlite.prepare('INSERT INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,url,'hash','ocr-v1',start,end,JSON.stringify(week),'now','now','paddleocr');
 return week;
}
let nextId=444;
const sent=()=>Response.json({id:String(nextId++),channel_id:'333'});
const successfulNetwork=()=>vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>init?.method==='DELETE'?new Response(null,{status:204}):sent());
const run=(create=false)=>updateMealBoard(db.env,'111','333',create);
const payload=(call:any)=>JSON.parse(typeof call[1].body==='string'?call[1].body:String(call[1].body.get('payload_json')));
beforeEach(()=>{
 nextId=444;db=testDatabase();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
 db.env.DISCORD_TOKEN='fixture';db.sqlite.exec("INSERT INTO guilds(id,meals_channel,schedule_channel,updated_at) VALUES('111','333','333','now')");
 vi.mocked(fetchImage).mockReset().mockResolvedValue({bytes:new Uint8Array([137,80,78,71]),mime:'image/png',hash:'fixture'});
});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.useRealTimers();});
describe('change-driven persistent boards',()=>{
 it('does not create during polling; creates once at an eligible slot and skips unchanged views',async()=>{
  seed();const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(sent());await run();expect(network).not.toHaveBeenCalled();
  await run(true);await run();await run(true);expect(network).toHaveBeenCalledTimes(1);expect(state().message_id).toBe('444');
  const body=payload(network.mock.calls[0]);expect(body.components.filter((component:any)=>component.type===17)).toHaveLength(2);expect(body.flags).toBe(32768);expect(body).not.toHaveProperty('content');expect(body).not.toHaveProperty('embeds');expect(body.allowed_mentions.parse).toEqual([]);
 });
 it('replaces changed menus only after success and skips unchanged audit timestamps',async()=>{
  const week=seed();const network=successfulNetwork();await run(true);
  db.sqlite.exec("UPDATE meals SET verified_at='later'; UPDATE meal_sources SET verified_at='later'");await run();expect(network).toHaveBeenCalledTimes(1);
  week.days[1].dinner=available('변경 메뉴');db.sqlite.prepare('UPDATE meals SET data=?').run(JSON.stringify(week));await run();
  expect(network.mock.calls.map(call=>call[1]!.method)).toEqual(['POST','POST','DELETE']);
  expect(network.mock.calls[2][0]).toContain('/messages/444');expect(state().message_id).toBe('445');
  expect(JSON.stringify(payload(network.mock.calls[1]))).toContain('변경 메뉴');await run();expect(network).toHaveBeenCalledTimes(3);
 });
 it('replaces morning/evening/next-day reports without delivery history',async()=>{
  seed();const network=successfulNetwork();await run(true);
  vi.setSystemTime(new Date('2026-10-13T08:30:00Z'));await run();expect(JSON.stringify(payload(network.mock.calls[1]))).toContain('내일 아침 (2026-10-14)');
  vi.setSystemTime(new Date('2026-10-13T22:00:00Z'));await run();expect(state().projection_key).toBe('2026-10-14:0');
  expect(network.mock.calls.map(call=>call[1]!.method)).toEqual(['POST','POST','DELETE','POST','DELETE']);expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(0);
 });
 it('removes image attachments once OCR text becomes usable',async()=>{
  const week=seed('2026-10-12','941660',false);const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(sent());await run(true);
  expect(payload(network.mock.calls[0]).attachments).toHaveLength(1);expect(payload(network.mock.calls[0]).components[0].components[1].items[0].media.url).toMatch(/^attachment:/);
  week.days[1].breakfastKorean=available('아침');week.days[1].dinner=available('저녁');db.sqlite.prepare('UPDATE meals SET data=?').run(JSON.stringify(week));await run();
  expect(payload(network.mock.calls[1]).attachments).toEqual([]);expect(JSON.stringify(payload(network.mock.calls[1]).components)).not.toContain('attachment://');
 });
 it('sends full two-week attachments on safely rejected Sunday POST retries',async()=>{
  seed('2026-10-12','941660',false);seed('2026-10-19','941999',false);
  const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({retry_after:60},{status:429})).mockResolvedValueOnce(sent()).mockResolvedValueOnce(new Response(null,{status:204}));await run(true);
  vi.setSystemTime(new Date('2026-10-18T08:30:00Z'));await expect(run()).rejects.toBeInstanceOf(BoardRetry);vi.setSystemTime(new Date('2026-10-18T08:31:00Z'));await run();
  for(const call of network.mock.calls.slice(1,3)){expect(call[1]!.method).toBe('POST');expect(payload(call).attachments.map((file:any)=>file.id)).toEqual([0,1]);expect((call[1]!.body as FormData).get('files[1]')).toBeInstanceOf(File);}
 });
 it('never recreates after an uncertain initial POST',async()=>{
  seed();const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('unknown'));await run(true);await run(true);
  vi.setSystemTime(new Date('2026-10-13T08:30:00Z'));await run(true);expect(network).toHaveBeenCalledTimes(1);expect(state().state).toBe('uncertain');
 });
 it('honors board-level Retry-After despite changed data and a new slot',async()=>{
  seed();const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({retry_after:86400},{status:429}));await run(true);
  vi.setSystemTime(new Date('2026-10-13T08:30:00Z'));await expect(run()).rejects.toMatchObject({retryAfter:86400});
  vi.setSystemTime(new Date('2026-10-13T22:00:00Z'));await expect(run()).rejects.toMatchObject({retryAfter:37800});expect(network).toHaveBeenCalledTimes(2);
 });
 it('freezes an uncertain replacement even with an old ID and reverted data',async()=>{
  const week=seed();const original=week.days[1].dinner;const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(sent()).mockRejectedValueOnce(new Error('unknown POST'));await run(true);
  week.days[1].dinner=available('B');db.sqlite.prepare('UPDATE meals SET data=?').run(JSON.stringify(week));await run();
  week.days[1].dinner=original;db.sqlite.prepare('UPDATE meals SET data=?').run(JSON.stringify(week));await run(true);
  expect(network).toHaveBeenCalledTimes(2);expect(state().state).toBe('uncertain');expect(state().message_id).toBe('444');
 });
 it('freezes an interrupted replacement with the previous message still tracked',async()=>{
  seed();const network=successfulNetwork();await run(true);
  db.sqlite.exec("UPDATE meal_messages SET state='creating',lease_owner='old',lease_until='2000-01-01'");await run();expect(network).toHaveBeenCalledTimes(1);expect(state().state).toBe('uncertain');expect(state().message_id).toBe('444');
 });
 it('resumes a confirmed rejected create outside bootstrap without replaying an old slot',async()=>{
  seed();const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({retry_after:60},{status:429})).mockResolvedValueOnce(sent());
  vi.setSystemTime(new Date('2026-10-12T22:14:00Z'));await expect(run(true)).rejects.toBeInstanceOf(BoardRetry);vi.setSystemTime(new Date('2026-10-12T22:15:00Z'));await run(false);
  expect(network.mock.calls.map(call=>call[1]!.method)).toEqual(['POST','POST']);expect(state().state).toBe('ready');
 });
 it('recovers transient image failure with a new image message after cooldown',async()=>{
  seed('2026-10-12','941660',false);vi.mocked(fetchImage).mockRejectedValueOnce(new Error('temporary'));
  const network=successfulNetwork();await run(true);expect(payload(network.mock.calls[0]).attachments).toEqual([]);await expect(run()).rejects.toMatchObject({retryAfter:900});
  vi.setSystemTime(new Date('2026-10-13T00:15:00Z'));await run();expect(network).toHaveBeenCalledTimes(3);expect(payload(network.mock.calls[1]).attachments).toHaveLength(1);expect(network.mock.calls[1][1]!.method).toBe('POST');expect(state().state).toBe('ready');
 });
 it('retains the old message after confirmed replacement rejection and retries current content',async()=>{
  const week=seed();const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({message:'denied'},{status:403})).mockResolvedValueOnce(sent()).mockResolvedValueOnce(new Response(null,{status:204}));await run(true);
  week.days[1].dinner=available('수정');db.sqlite.prepare('UPDATE meals SET data=?').run(JSON.stringify(week));await run();
  expect(state().message_id).toBe('444');expect(state().state).toBe('failed');expect(network).toHaveBeenCalledTimes(2);
  await run();expect(network.mock.calls.map(call=>call[1]!.method)).toEqual(['POST','POST','POST','DELETE']);expect(state().message_id).toBe('445');
 });
 it('retries failed deletion independently without reposting the confirmed replacement',async()=>{
  const week=seed();const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(sent()).mockResolvedValueOnce(sent()).mockResolvedValueOnce(Response.json({retry_after:120},{status:429})).mockResolvedValueOnce(Response.json({code:10008},{status:404}));await run(true);
  week.days[1].dinner=available('수정');db.sqlite.prepare('UPDATE meals SET data=?').run(JSON.stringify(week));await run();await run();
  expect(state().message_id).toBe('445');expect(state().state).toBe('ready');expect(network).toHaveBeenCalledTimes(3);
  const cleanup=db.sqlite.prepare("SELECT * FROM jobs WHERE kind='meal-cleanup'").get() as unknown as Job;
  expect(cleanup.state).toBe('pending');expect(cleanup.available_at).toBe('2026-10-13T00:02:00.000Z');
  await executeJob(db.env,cleanup);expect(network.mock.calls[3][1]!.method).toBe('DELETE');expect(network.mock.calls[3][0]).toContain('/messages/444');
 });
 it('does not delete or replay a confirmed POST if persisting replacement proof fails',async()=>{
  const week=seed();const network=successfulNetwork();await run(true);
  week.days[1].dinner=available('수정');db.sqlite.prepare('UPDATE meals SET data=?').run(JSON.stringify(week));
  vi.spyOn(db.env.DB,'batch').mockRejectedValueOnce(new Error('D1 unavailable'));
  await expect(run()).rejects.toThrow('D1 unavailable');expect(state().message_id).toBe('444');expect(state().state).toBe('creating');
  expect(network.mock.calls.map(call=>call[1]!.method)).toEqual(['POST','POST']);
  vi.setSystemTime(new Date('2026-10-13T00:21:00Z'));await run();expect(state().state).toBe('uncertain');expect(network).toHaveBeenCalledTimes(2);
 });
 it('blocks concurrent replacement POSTs and keeps the previous message until success',async()=>{
  const week=seed();const network=successfulNetwork();await run(true);
  week.days[1].dinner=available('수정');db.sqlite.prepare('UPDATE meals SET data=?').run(JSON.stringify(week));
  let finish!:(response:Response)=>void;network.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const first=run();
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));await expect(run()).rejects.toBeInstanceOf(BoardRetry);expect(state().message_id).toBe('444');expect(state().state).toBe('creating');
  finish(sent());await first;expect(network.mock.calls.map(call=>call[1]!.method)).toEqual(['POST','POST','DELETE']);
 });
 it('preserves schedule reconciliation after uncertain PATCH and reverted content',async()=>{
  const original:Schedule={id:'a',title:'A',startDate:'2026-10-14',type:'event',sourceUrl:'https://www.sogang.ac.kr/ko/academic-support/calendar',lastReviewed:'2026-10-13',active:true,note:''};
  const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(sent()).mockRejectedValueOnce(new Error('unknown edit')).mockResolvedValueOnce(new Response(null,{status:204}));
  await updateScheduleSummary(db.env,'111','333','2026-10-13',[original]);
  await expect(updateScheduleSummary(db.env,'111','333','2026-10-13',[{...original,title:'B'}],false)).rejects.toBeInstanceOf(BoardRetry);
  vi.setSystemTime(new Date('2026-10-13T00:01:00Z'));await updateScheduleSummary(db.env,'111','333','2026-10-13',[original],false);
  expect(network.mock.calls.map(call=>call[1]!.method)).toEqual(['POST','PATCH','PATCH']);
 });
 it('checks slot/date after the final awaited channel lookup',async()=>{
  seed();const original=db.env.DB.prepare.bind(db.env.DB);let reads=0;
  vi.spyOn(db.env.DB,'prepare').mockImplementation(sql=>{const statement=original(sql);if(sql.includes('SELECT meals_channel AS channel'))vi.spyOn(statement,'bind').mockImplementation((...values)=>{const bound=original(sql).bind(...values);vi.spyOn(bound,'first').mockImplementation(async()=>{if(++reads===2)vi.setSystemTime(new Date('2026-10-13T15:00:01Z'));return {channel:'333'} as never;});return bound;});return statement;});
  const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(sent());await run(true);expect(network).not.toHaveBeenCalled();expect(state().message_id).toBeNull();
 });
 it('migration preserves ready IDs and uncertain tracking exactly',()=>{
  const legacy=new DatabaseSync(':memory:');try{
   legacy.exec(readFileSync('migrations/0006_schedule_messages.sql','utf8'));legacy.exec("INSERT INTO schedule_messages(guild_id,channel_id,message_id,state,updated_at,error) VALUES('111','333','555','ready','old',NULL),('222','333',NULL,'uncertain','old','unknown POST')");
   const before=legacy.prepare('SELECT * FROM schedule_messages ORDER BY guild_id').all();legacy.exec(readFileSync('migrations/0008_message_boards.sql','utf8'));
   const after=legacy.prepare('SELECT * FROM schedule_messages ORDER BY guild_id').all();for(const [i,row] of after.entries()){expect(row.content_hash).toBeNull();expect(row.projection_key).toBeNull();delete row.content_hash;delete row.projection_key;expect(row).toEqual(before[i]);}
  }finally{legacy.close();}
 });
 it('blocks concurrent creation',async()=>{
  seed();let finish!:(response:Response)=>void;const network=vi.spyOn(globalThis,'fetch').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const first=run(true);
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));await expect(run(true)).rejects.toBeInstanceOf(BoardRetry);expect(network).toHaveBeenCalledTimes(1);finish(sent());await first;
 });
 it('does not send a stale projection when download crosses slot or midnight',async()=>{
  seed('2026-10-12','941660',false);const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(sent());await run(true);
  db.sqlite.exec("UPDATE meal_messages SET content_hash=NULL");vi.setSystemTime(new Date('2026-10-13T08:29:30Z'));
  vi.mocked(fetchImage).mockImplementationOnce(async()=>{vi.setSystemTime(new Date('2026-10-13T08:30:30Z'));return {bytes:new Uint8Array([1]),mime:'image/png',hash:'x'};});await run();expect(network).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date('2026-10-13T14:59:30Z'));vi.mocked(fetchImage).mockImplementationOnce(async()=>{vi.setSystemTime(new Date('2026-10-13T15:00:30Z'));return {bytes:new Uint8Array([1]),mime:'image/png',hash:'x'};});await run();expect(network).toHaveBeenCalledTimes(1);
 });
 it('preserves existing IDs through migration and separates features in the same channel',async()=>{
  seed();const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(sent());db.sqlite.exec("INSERT INTO schedule_messages(guild_id,channel_id,message_id,state,updated_at,updated_date) VALUES('111','333','555','ready','old','2026-10-13')");
  await updateScheduleSummary(db.env,'111','333','2026-10-13',[]);await run(true);
  expect(network.mock.calls[0][0]).toContain('/messages/555');expect(network.mock.calls[0][1]!.method).toBe('PATCH');expect(state().message_id).toBe('444');
 });
 it('refreshes changed same-day schedules without repeated edits for identical content',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(sent());const item:Schedule={id:'a',title:'일정',startDate:'2026-10-14',type:'event',sourceUrl:'https://www.sogang.ac.kr/ko/academic-support/calendar',lastReviewed:'2026-10-13',active:true,note:''};
  await updateScheduleSummary(db.env,'111','333','2026-10-13',[item]);await updateScheduleSummary(db.env,'111','333','2026-10-13',[item]);expect(network).toHaveBeenCalledTimes(1);
  item.title='변경 일정';await updateScheduleSummary(db.env,'111','333','2026-10-13',[item],false);expect(network.mock.calls[1][1]!.method).toBe('PATCH');expect(JSON.stringify(payload(network.mock.calls[1]))).toContain('변경 일정');
 });
 it('isolates guild queues so one rate-limited board cannot block another',async()=>{
  vi.setSystemTime(new Date('2026-10-12T22:00:00Z'));seed();db.sqlite.exec("INSERT INTO guilds(id,meals_channel,updated_at) VALUES('222','999','now')");
  await executeJob(db.env,{id:'slot',kind:'meal-report',payload:JSON.stringify({date:'2026-10-13',mealSlot:'morning'})} as Job);
  const children=db.sqlite.prepare("SELECT * FROM jobs WHERE kind='meal-board' ORDER BY id").all() as unknown as Job[];expect(children).toHaveLength(2);
  const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({retry_after:120},{status:429})).mockResolvedValueOnce(Response.json({id:'777',channel_id:'999'}));
  await expect(executeJob(db.env,children[0])).rejects.toBeInstanceOf(BoardRetry);await executeJob(db.env,children[1]);
  expect(network).toHaveBeenCalledTimes(2);expect(db.sqlite.prepare("SELECT message_id FROM meal_messages WHERE guild_id='222'").get()!.message_id).toBe('777');
 });
 it('polls every 15 minutes but does not bootstrap new boards outside their approved windows',async()=>{
  vi.setSystemTime(new Date('2026-10-13T02:00:00Z'));seed();const network=vi.spyOn(globalThis,'fetch').mockResolvedValue(sent());await planCron(db.env,Date.now());
  expect(db.sqlite.prepare("SELECT kind FROM jobs WHERE kind IN ('meal-refresh','schedule-refresh') ORDER BY kind").all()).toEqual([{kind:'meal-refresh'},{kind:'schedule-refresh'}]);
  await executeJob(db.env,{id:'poll',kind:'meal-refresh',payload:JSON.stringify({date:'2026-10-13'})} as Job);expect(network).not.toHaveBeenCalled();
  await executeJob(db.env,{id:'stale-slot',kind:'meal-report',payload:JSON.stringify({date:'2026-10-13',mealSlot:'morning'})} as Job);expect(network).not.toHaveBeenCalled();
 });
});
