import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {testDatabase} from './helpers/db';
import {consume,mealReportResponse,planCron} from '../src/jobs';
import {deliveryIntent} from '../src/storage';
import {addDays} from '../src/time';
import {fetchImage} from '../src/sources';
vi.mock('../src/sources',async original=>({...await original<object>(),fetchImage:vi.fn()}));
let db:ReturnType<typeof testDatabase>;
const source=(id:string)=>`https://scc.sogang.ac.kr/front/cmsboardview.do?bbsConfigFK=1185&siteId=dormitory&pkid=${id}`;
const unknown=()=>({status:'unknown',items:[],time:null,evidence:''});
const available=(item:string)=>({status:'available',items:[item],time:null,evidence:item});
function seed(start='2026-10-12',id='941660',known=true){
 const end=addDays(start,6),url=source(id);
 db.sqlite.prepare('INSERT INTO meal_sources VALUES(?,?,?,?,?,?)').run(url,`https://scc.sogang.ac.kr/dataview/board/1185/${id}.png`,start,start,end,new Date().toISOString());
 const week={start,end,certain:true,days:Array.from({length:7},(_,i)=>({date:addDays(start,i),weekday:i+1,breakfastKorean:known?available(`아침-${addDays(start,i)}`):unknown(),breakfastWestern:unknown(),breakfastCommon:unknown(),dinner:known?available(`저녁-${addDays(start,i)}`):unknown(),cupRice:available('컵밥-별도'),drinks:unknown()}))};
 db.sqlite.prepare('INSERT INTO meals(cache_key,source_url,image_hash,version,start_date,end_date,data,extracted_at,verified_at,model) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,url,'hash','ocr-v1',start,end,JSON.stringify(week),'now','now','paddleocr');
 return week;
}
async function intent(slot='morning',date='2026-10-13'){
 const id=`meal-report:111:${date}:${slot}`;
 // Previously queued delivery payloads retain their original no-replay semantics.
 await deliveryIntent(db.env,id,'111','1001','legacy',slot==='morning'?`${date}T08:30:00.000Z`:`${date}T15:00:00.000Z`,date,slot as 'morning'|'evening');
 return id;
}
async function send(id:string){const msg={body:{id:`send:${id}`},ack:vi.fn()};await consume(db.env,{messages:[msg]} as never);return msg;}
beforeEach(()=>{
 db=testDatabase();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
 db.env.DISCORD_TOKEN='fixture';db.sqlite.exec("INSERT INTO guilds(id,meals_channel,updated_at) VALUES('111','1001','now')");
 vi.mocked(fetchImage).mockReset().mockResolvedValue({bytes:new Uint8Array([137,80,78,71]),mime:'image/png',hash:'fixture'});
});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.useRealTimers();});
describe('paired meal reports',()=>{
 it('morning includes today breakfast/dinner, never tomorrow or cup rice',async()=>{
  seed();const text=await mealReportResponse(db.env,'2026-10-13','morning');
  expect(text).toContain('오늘 아침 (2026-10-13)');expect(text).toContain('아침-2026-10-13');expect(text).toContain('오늘 저녁 (2026-10-13)');expect(text).toContain('저녁-2026-10-13');
  expect(text).not.toContain('2026-10-14');expect(text).not.toContain('컵밥-별도');expect(fetchImage).not.toHaveBeenCalled();
 });
 it('evening includes today dinner and tomorrow breakfast, not today breakfast or tomorrow dinner',async()=>{
  seed();const text=await mealReportResponse(db.env,'2026-10-13','evening');
  expect(text).toContain('저녁-2026-10-13');expect(text).toContain('내일 아침 (2026-10-14)');expect(text).toContain('아침-2026-10-14');
  expect(text).not.toContain('아침-2026-10-13');expect(text).not.toContain('저녁-2026-10-14');
 });
 it('uses next-week cache on Sunday without substituting current-week Monday',async()=>{
  vi.setSystemTime(new Date('2026-10-18T08:30:00Z'));seed();seed('2026-10-19','941999');
  const text=await mealReportResponse(db.env,'2026-10-18','evening');expect(text).toContain('아침-2026-10-19');expect(text).not.toContain('아침-2026-10-12');
 });
 it('deduplicates same-week fallback downloads and checks each selected section, not the whole day',async()=>{
  seed('2026-10-12','941660',false);const result=await mealReportResponse(db.env,'2026-10-13','morning');
  expect(typeof result).toBe('object');expect((result as any).files).toHaveLength(1);expect(fetchImage).toHaveBeenCalledTimes(1);
  const week=seed('2026-10-19','941999');week.days[0].breakfastKorean=unknown();
  db.sqlite.prepare('UPDATE meals SET data=? WHERE cache_key=?').run(JSON.stringify(week),'941999');
  const partial=await mealReportResponse(db.env,'2026-10-18','evening');expect((partial as any).files).toHaveLength(2);
 });
 it('uploads two explicitly identified week images on Sunday and never retries an uncertain POST',async()=>{
  vi.setSystemTime(new Date('2026-10-18T08:30:00Z'));seed('2026-10-12','941660',false);seed('2026-10-19','941999',false);
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('unknown outcome'));
  const id=await intent('evening','2026-10-18');await send(id);await send(id);
  expect(network).toHaveBeenCalledTimes(1);const form=network.mock.calls[0][1]!.body as FormData;
  const body=JSON.parse(String(form.get('payload_json')));expect(body.attachments).toHaveLength(2);expect(form.get('files[1]')).toBeInstanceOf(File);expect(body.content).toContain('내일 아침 (2026-10-19)');
  expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(id)!.state).toBe('uncertain');
 });
 it('caps combined fallback bytes and keeps the second week link when it cannot be attached',async()=>{
  vi.setSystemTime(new Date('2026-10-18T08:30:00Z'));seed('2026-10-12','941660',false);seed('2026-10-19','941999',false);
  vi.mocked(fetchImage).mockResolvedValue({bytes:new Uint8Array(3*1024*1024),mime:'image/png',hash:'fixture'});
  const result=await mealReportResponse(db.env,'2026-10-18','evening') as any;
  expect(result.files).toHaveLength(1);expect(result.content).toContain(source('941999'));expect(result.content).toContain('이미지 첨부 불가');
 });
 it('retries only a confirmed 429 with the complete two-week attachment set',async()=>{
  vi.setSystemTime(new Date('2026-10-18T08:30:00Z'));seed('2026-10-12','941660',false);seed('2026-10-19','941999',false);
  const network=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json({retry_after:120},{status:429})).mockResolvedValueOnce(Response.json({id:'9001',channel_id:'1001'}));
  const id=await intent('evening','2026-10-18');await send(id);vi.advanceTimersByTime(120000);await send(id);
  expect(network).toHaveBeenCalledTimes(2);expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(id)!.state).toBe('sent');
  for(const [,request] of network.mock.calls){const form=request!.body as FormData;expect(JSON.parse(String(form.get('payload_json'))).attachments.map((x:any)=>x.id)).toEqual([0,1]);expect(form.get('files[1]')).toBeInstanceOf(File);}
 });
 it('leaves next Monday unknown/link-only when no matching source exists',async()=>{
  vi.setSystemTime(new Date('2026-10-18T08:30:00Z'));seed();const result=await mealReportResponse(db.env,'2026-10-18','evening');
  expect(typeof result).toBe('string');expect(result).toContain('내일 아침 (2026-10-19)');expect(result).toContain('식단 확인 불가');expect(fetchImage).not.toHaveBeenCalled();
 });
 it('preserves complete links and both headings under the Discord text limit',async()=>{
  const week=seed();for(const day of week.days)for(const field of ['breakfastKorean','breakfastWestern','breakfastCommon','dinner'] as const)day[field]=available('메뉴😀'.repeat(35));
  for(const day of week.days)for(const field of ['breakfastKorean','breakfastWestern','breakfastCommon','dinner'] as const)day[field].items=Array(20).fill('메뉴😀'.repeat(25));
  db.sqlite.prepare('UPDATE meals SET data=? WHERE cache_key=?').run(JSON.stringify(week),'941660');
  const text=await mealReportResponse(db.env,'2026-10-13','morning') as string;expect(text.length).toBeLessThanOrEqual(2000);expect(text.split(`<${source('941660')}>`)).toHaveLength(3);expect(text).toContain('오늘 저녁');
 });
 it('never carries a morning delivery across the evening slot during download',async()=>{
  vi.setSystemTime(new Date('2026-10-13T08:29:30Z'));seed('2026-10-12','941660',false);
  vi.mocked(fetchImage).mockImplementationOnce(async()=>{vi.advanceTimersByTime(60000);return {bytes:new Uint8Array([1]),mime:'image/png',hash:'fixture'};});
  const network=vi.spyOn(globalThis,'fetch');const id=await intent();await send(id);expect(network).not.toHaveBeenCalled();expect(db.sqlite.prepare('SELECT state FROM deliveries WHERE id=?').get(id)!.state).toBe('expired');
 });
 it('gives both slots independent durable identities and deduplicates execution',async()=>{
  seed();const a=await intent();await intent();vi.setSystemTime(new Date('2026-10-13T08:30:00Z'));const b=await intent('evening');await intent('evening');
  expect(a).not.toBe(b);expect(db.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n).toBe(2);
 });
 it('plans only the approved report windows while retaining 07:30 schedule-board timing',async()=>{
  for(const time of ['2026-10-12T22:00:00Z','2026-10-12T22:00:00Z','2026-10-12T22:15:00Z','2026-10-12T22:30:00Z','2026-10-13T08:30:00Z'])await planCron(db.env,Date.parse(time));
  const jobs=db.sqlite.prepare("SELECT id,kind FROM jobs WHERE kind IN ('meal-report','meal-daily','schedule-daily') ORDER BY id").all();
  expect(jobs).toEqual([{id:'meal-report:2026-10-13:evening',kind:'meal-report'},{id:'meal-report:2026-10-13:morning',kind:'meal-report'},{id:'schedule-daily:2026-10-13',kind:'schedule-daily'}]);
 });
});
