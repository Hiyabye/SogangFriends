import {describe,it,expect,vi,afterEach} from 'vitest';
import {LIBRARY_URL,parseLibrarySnapshot,fetchLibrarySnapshot} from '../src/library-source.ts';
const now=Date.parse('2026-10-16T11:24:20Z');
const row=(room='5',label='133 로욜라 인벤툼 II')=>`<tr><td>2</td><td><a href="roomview5.asp?room_no=${room}">${label}</a></td><td>102 <font color=blue>(4)</font></td><td>100</td><td>2</td><td><img alt="98.04 %">98.04 %</td><td style="display:none">5</td></tr>`;
const head='<tr><td>순번</td><td>열람실명</td><td>전체 좌석수</td><td>사용 좌석수</td><td>잔여 좌석수</td><td>이용율(%)</td><td>순번</td></tr>';
const stamp='<tr><td colspan="7">2026-10-16&nbsp;오후 8:24:20 현재&nbsp;</td></tr>';
const html=(rows=row())=>`<html><head><!-- 2020-01-01 오전 1:00:00 현재 --></head><body><table>${stamp}${head}${row('19','111 로욜라 인벤툼Ⅰ')}${rows}</table><table><tr><td>좌석 해지 예상 시간표</td></tr>${stamp}</table></body></html>`;
const asciiEntities=(s:string)=>s.replace(/[^\x00-\x7f]/g,c=>`&#${c.codePointAt(0)};`);
function encodedPage():Uint8Array{
 // Real CP949 room-name bytes mixed with ASCII entity markup, not UTF-8 masquerading as EUC-KR.
 const marker='CP949_ROOM',page=asciiEntities(html().replace('로욜라 인벤툼 II',`${marker} II`)),parts=page.split(marker);
 return Uint8Array.from(Buffer.concat([Buffer.from(parts[0]),Buffer.from('b7cebfe7b6f320c0cebaa5c5f9','hex'),Buffer.from(parts[1])]));
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
describe('library source parser',()=>{
 it('selects room identity, not row position; ignores disability capacity in total and unrelated timestamps',()=>{
  expect(parseLibrarySnapshot(html(),now)).toEqual({total:102,used:100,remaining:2,sourceAt:'2026-10-16T11:24:20.000Z'});
  expect(parseLibrarySnapshot(html(row('6','K관 열람실')+row()),now).remaining).toBe(2);
 });
 it('normalizes whitespace and equivalent roman numeral labels',()=>{
  expect(parseLibrarySnapshot(html(row('5','133&nbsp; 로욜라\n 인벤툼 Ⅱ')),now).total).toBe(102);
 });
 it.each([
  ['missing target',()=>html('')],
  ['duplicate target',()=>html(row()+row())],
  ['wrong label',()=>html(row('5','131 로욜라 인벤툼 II'))],
  ['foreign origin',()=>html().replace('href="roomview5.asp?room_no=5"','href="https://example.com/SEAT/roomview5.asp?room_no=5"')],
  ['ambiguous room query',()=>html().replace('room_no=5"','room_no=5&amp;room_no=6"')],
  ['partial target row',()=>html(row().slice(0,row().indexOf('<td>100')))],
  ['missing aggregate header',()=>html().replace('전체 좌석수','다른 값')],
  ['incorrect arithmetic',()=>html(row().replace('<td>100</td>','<td>99</td>'))],
  ['negative remaining',()=>html(row().replace('<td>2</td><td><img','<td>-2</td><td><img'))],
  ['wrong occupancy',()=>html(row().replace('>98.04 %</td>','>50 %</td>'))],
  ['disability capacity exceeds total',()=>html(row().replace('(4)','(103)'))],
  ['missing disability annotation',()=>html(row().replace('<font color=blue>(4)</font>',''))],
  ['duplicate source timestamp',()=>html().replace(head,stamp+head)],
  ['invalid calendar date',()=>html().replaceAll('2026-10-16','2026-02-30')],
  ['invalid 12-hour time',()=>html().replaceAll('오후 8:24:20','오후 0:24:20')],
  ['invalid minute',()=>html().replaceAll('8:24:20','8:60:20')],
  ['detail page rather than aggregate table',()=>`<table>${stamp}${row()}</table>`],
 ] as const)('rejects %s',(_name,make)=>{expect(()=>parseLibrarySnapshot(make(),now)).toThrow('Invalid library snapshot');});
 it('takes timestamp only from target aggregate table',()=>{
  expect(()=>parseLibrarySnapshot(html().replace(stamp,''),now)).toThrow();
 });
 it('enforces source age and future tolerance at their boundaries',()=>{
  expect(parseLibrarySnapshot(html(),now+120000).remaining).toBe(2);
  expect(()=>parseLibrarySnapshot(html(),now+120001)).toThrow();
  expect(parseLibrarySnapshot(html(),now-30000).remaining).toBe(2);
  expect(()=>parseLibrarySnapshot(html(),now-30001)).toThrow();
 });
 it('converts noon and midnight without inferring dates',()=>{
  const noon=html().replaceAll('오후 8:24:20','오후 12:24:20');
  expect(parseLibrarySnapshot(noon,Date.parse('2026-10-16T03:24:20Z')).sourceAt).toBe('2026-10-16T03:24:20.000Z');
  const midnight=html().replaceAll('오후 8:24:20','오전 12:24:20');
  expect(parseLibrarySnapshot(midnight,Date.parse('2026-10-15T15:24:20Z')).sourceAt).toBe('2026-10-15T15:24:20.000Z');
 });
});
describe('bounded library collection',()=>{
 it('decodes real CP949 bytes with fixed URL and no redirect following',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const fetcher=vi.fn(async()=>new Response(encodedPage(),{headers:{'content-type':'text/html; charset=euc-kr'}}));vi.stubGlobal('fetch',fetcher);
  expect(await fetchLibrarySnapshot()).toMatchObject({total:102,remaining:2,sourceAt:'2026-10-16T11:24:20.000Z'});
  expect(fetcher).toHaveBeenCalledWith(LIBRARY_URL,expect.objectContaining({redirect:'manual',signal:expect.any(AbortSignal)}));
 });
 it.each([302,403,500])('rejects HTTP %s without exposing body',async status=>{
  const cancel=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({cancel}),{status,headers:{'content-type':'text/html',location:'https://example.com'}})));
  await expect(fetchLibrarySnapshot()).rejects.toThrow(/^Library collection failed$/);expect(cancel).toHaveBeenCalled();
 });
 it('rejects non-HTML responses',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{headers:{'content-type':'application/json'}})));
  await expect(fetchLibrarySnapshot()).rejects.toThrow('Library collection failed');
 });
 it.each([true,false])('bounds bytes with/without Content-Length (%s)',async declared=>{
  const cancel=vi.fn();const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(256*1024+1));},cancel});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(stream,{headers:{'content-type':'text/html',...(declared?{'content-length':String(256*1024+1)}:{})}})));
  await expect(fetchLibrarySnapshot()).rejects.toThrow('Library collection failed');expect(cancel).toHaveBeenCalled();
 });
 it('rejects invalid encoded bytes',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(Uint8Array.of(0xff),{headers:{'content-type':'text/html'}})));
  await expect(fetchLibrarySnapshot()).rejects.toThrow('Library collection failed');
 });
 it('covers stalled body streaming with the eight-second deadline',async()=>{
  vi.useFakeTimers();const cancel=vi.fn();let signal:AbortSignal|undefined;
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,options:RequestInit)=>{signal=options.signal!;return new Response(new ReadableStream({cancel}),{headers:{'content-type':'text/html'}});}));
  const pending=fetchLibrarySnapshot();const assertion=expect(pending).rejects.toThrow('Library collection failed');
  await vi.advanceTimersByTimeAsync(8000);await assertion;expect(signal?.aborted).toBe(true);expect(cancel).toHaveBeenCalled();
 });
 it('bounds a stalled fetch and sanitizes upstream exceptions',async()=>{
  vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>{})));
  const pending=fetchLibrarySnapshot();const assertion=expect(pending).rejects.toThrow(/^Library collection failed$/);
  await vi.advanceTimersByTimeAsync(8000);await assertion;
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('upstream secret body');}));
  await expect(fetchLibrarySnapshot()).rejects.toThrow(/^Library collection failed$/);
 });
});
