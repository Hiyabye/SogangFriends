import {describe,it,expect,vi,afterEach} from 'vitest';
import {LIBRARY_URL,parseLibrarySnapshot,fetchLibrarySnapshot} from '../src/library-source.ts';
const now=Date.parse('2026-10-16T11:24:20Z');
const excluded=[1,3,44,85,101,102];
const stamp='2026-10-16&nbsp;오후 8:24:20 현재';
const seat=(id:number,free=false)=>`<div id="Layer${id}" style="position:absolute; width:${excluded.includes(id)?1:38}px"><table><tr><td bgcolor="${free?'gray':'red'}"><font style="color:yellow">${id}</font></td></tr></table></div>`;
const legend='<table><tr><td bgcolor="red">사용중</td><td></td><td bgcolor="gray">미사용</td></tr></table>';
const summary=(free=2)=>`<table><tr><td><b>133 로욜라 인벤툼 II</b></td><td>총 좌석수 : <b>102</b></td><td>사용 좌석수 : <b>${102-free}</b></td><td>잔여 좌석수 : <b>${free}</b></td><td>${stamp}</td></tr></table>`;
const map=(free=[2,84])=>`<div id="maptemp"><div id="backimage"><img src="./MAP/5-back.jpg"></div>${Array.from({length:102},(_,i)=>seat(i+1,free.includes(i+1))).join('')}</div>`;
// Original synthetic markup represents the observed same-response summary/legend/map contract.
const html=(free=[2,84])=>`<html><body>${legend}${summary(free.length)}${map(free)}</body></html>`;
const asciiEntities=(s:string)=>s.replace(/[^\x00-\x7f]/g,c=>`&#${c.codePointAt(0)};`);
function encodedPage():Uint8Array{
 // Real CP949 room-name bytes mixed with ASCII entity markup, not UTF-8 masquerading as EUC-KR.
 const marker='CP949_ROOM',page=asciiEntities(html().replace('로욜라 인벤툼 II',`${marker} II`)),parts=page.split(marker);
 return Uint8Array.from(Buffer.concat([Buffer.from(parts[0]),Buffer.from('b7cebfe7b6f320c0cebaa5c5f9','hex'),Buffer.from(parts[1])]));
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
describe('library detailed seat source parser',()=>{
 it('counts only eligible seats using the room-5 map and its own summary timestamp',()=>{
  expect(parseLibrarySnapshot(html(),now)).toEqual({total:96,used:94,remaining:2,sourceAt:'2026-10-16T11:24:20.000Z'});
  expect(LIBRARY_URL).toBe('https://libseat.sogang.ac.kr:444/SEAT/roomview5.asp?room_no=5');
 });
 it('normalizes summary whitespace and equivalent roman numeral labels',()=>{
  expect(parseLibrarySnapshot(html().replace('133 로욜라 인벤툼 II','133&nbsp; 로욜라\n 인벤툼 Ⅱ'),now).total).toBe(96);
 });
 it.each(excluded)('does not count excluded seat %s even when it is the only free seat',id=>{
  expect(parseLibrarySnapshot(html([id]),now)).toMatchObject({total:96,used:96,remaining:0});
 });
 it('counts zero available eligible seats when all six excluded seats are free',()=>{
  expect(parseLibrarySnapshot(html(excluded),now)).toMatchObject({total:96,used:96,remaining:0});
 });
 it('counts only eligible availability in a mixed map rather than subtracting six from the free count',()=>{
  expect(parseLibrarySnapshot(html([1,3,44,85,101,102,2,100]),now)).toMatchObject({total:96,used:94,remaining:2});
  expect(parseLibrarySnapshot(html([84]),now).remaining).toBe(1);
 });
 it.each([{free:[]},{free:Array.from({length:102},(_,i)=>i+1)}])('handles fully occupied and fully available maps ($free)',({free})=>{
  expect(parseLibrarySnapshot(html(free),now)).toMatchObject({total:96,used:free.length?0:96,remaining:free.length?96:0});
 });
 it('uses seat identity and legend rather than layer order or the tiny disabled-seat drawing size',()=>{
  const reordered=html().replace(map(),`<div id="maptemp"><div id="backimage"><img src="./MAP/5-back.jpg"></div>${Array.from({length:102},(_,i)=>seat(102-i,[2,84].includes(102-i))).join('')}</div>`);
  expect(parseLibrarySnapshot(reordered,now).remaining).toBe(2);
  expect(parseLibrarySnapshot(html([2]),now).remaining).toBe(1);
 });
 it.each([
  ['missing summary',()=>legend+map()],
  ['duplicate summary',()=>html()+summary()],
  ['wrong room label',()=>html().replace('133 로욜라 인벤툼 II','131 로욜라 인벤툼 II')],
  ['wrong summary total',()=>html().replace('총 좌석수 : <b>102','총 좌석수 : <b>103')],
  ['incorrect summary arithmetic',()=>html().replace('사용 좌석수 : <b>100','사용 좌석수 : <b>99')],
  ['negative remaining',()=>html().replace('잔여 좌석수 : <b>2','잔여 좌석수 : <b>-2')],
  ['missing summary label',()=>html().replace('총 좌석수','전체 좌석')],
  ['missing timestamp',()=>html().replace(stamp,'')],
  ['duplicate summary timestamp',()=>html().replace(stamp,stamp+' '+stamp)],
  ['invalid calendar date',()=>html().replace('2026-10-16','2026-02-30')],
  ['invalid 12-hour time',()=>html().replace('오후 8:24:20','오후 0:24:20')],
  ['invalid minute',()=>html().replace('8:24:20','8:60:20')],
  ['missing map',()=>legend+summary()],
  ['duplicate map',()=>html()+map()],
  ['missing map identity',()=>html().replace('id="maptemp"','id="other"')],
  ['missing background identity',()=>html().replace('id="backimage"','id="other"')],
  ['duplicate background',()=>html().replace('<div id="backimage">','<div id="backimage"></div><div id="backimage">')],
  ['wrong room background',()=>html().replace('5-back.jpg','6-back.jpg')],
  ['foreign background',()=>html().replace('./MAP/5-back.jpg','https://example.com/SEAT/MAP/5-back.jpg')],
  ['background query',()=>html().replace('5-back.jpg','5-back.jpg?room_no=6')],
  ['missing seat',()=>html().replace(seat(100),'')],
  ['missing excluded seat',()=>html().replace(seat(1),'')],
  ['duplicate seat',()=>html().replace(seat(100),seat(99))],
  ['extra seat',()=>html().replace('</body>',seat(103)+'</body>')],
  ['seat outside map',()=>html().replace(seat(100),'').replace('</body>',seat(100)+'</body>')],
  ['wrong seat label',()=>html().replace(seat(100),seat(100).replace('>100</font>','>99</font>'))],
  ['noncanonical layer ID',()=>html().replace('id="Layer1"','id="Layer01"')],
  ['unexpected layer ID',()=>html().replace('id="Layer1"','id="Layer103"')],
  ['unknown seat status',()=>html().replace(seat(100),seat(100).replace('bgcolor="red"','bgcolor="green"'))],
  ['unknown excluded seat status',()=>html().replace(seat(1),seat(1).replace('bgcolor="red"','bgcolor="green"'))],
  ['missing seat status',()=>html().replace(seat(100),seat(100).replace('bgcolor="red"',''))],
  ['duplicate status attribute',()=>html().replace(seat(100),seat(100).replace('bgcolor="red"','bgcolor="red" bgcolor="gray"'))],
  ['contradictory inline background',()=>html().replace(seat(100),seat(100).replace('bgcolor="red"','bgcolor="red" style="background-color:gray"'))],
  ['ambiguous extra status cell',()=>html().replace(seat(100),seat(100).replace('</tr>','<td bgcolor="gray">100</td></tr>'))],
  ['summary/map disagreement',()=>html().replace(seat(100),seat(100,true))],
  ['missing legend',()=>html().replace(legend,'')],
  ['reversed legend',()=>html().replace('bgcolor="red">사용중','bgcolor="gray">사용중')],
  ['duplicate legend',()=>html()+legend],
  ['unrecognized extra map cell',()=>html().replace(seat(100),seat(100)+'<table><tr><td bgcolor="gray">103</td></tr></table>')],
 ] as const)('rejects %s',(_name,make)=>{expect(()=>parseLibrarySnapshot(make(),now)).toThrow('Invalid library snapshot');});
 it('ignores unrelated timestamps, including comments, without using them to repair missing summary dates',()=>{
  expect(parseLibrarySnapshot(html()+'<table><tr><td>1999-01-01 오전 1:00:00 현재</td></tr></table><!-- invalid date -->',now).remaining).toBe(2);
  expect(()=>parseLibrarySnapshot(html().replace(stamp,'')+`<table><tr><td>${stamp}</td></tr></table>`,now)).toThrow();
 });
 it('enforces source age and future tolerance at their boundaries',()=>{
  expect(parseLibrarySnapshot(html(),now+120000).remaining).toBe(2);
  expect(()=>parseLibrarySnapshot(html(),now+120001)).toThrow();
  expect(parseLibrarySnapshot(html(),now-30000).remaining).toBe(2);
  expect(()=>parseLibrarySnapshot(html(),now-30001)).toThrow();
 });
 it('converts noon and midnight without inferring dates',()=>{
  const noon=html().replace('오후 8:24:20','오후 12:24:20');
  expect(parseLibrarySnapshot(noon,Date.parse('2026-10-16T03:24:20Z')).sourceAt).toBe('2026-10-16T03:24:20.000Z');
  const midnight=html().replace('오후 8:24:20','오전 12:24:20');
  expect(parseLibrarySnapshot(midnight,Date.parse('2026-10-15T15:24:20Z')).sourceAt).toBe('2026-10-15T15:24:20.000Z');
 });
});
describe('bounded library collection',()=>{
 it('decodes real CP949 bytes with fixed detail URL and no redirect following',async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const fetcher=vi.fn(async()=>new Response(encodedPage(),{headers:{'content-type':'text/html; charset=euc-kr'}}));vi.stubGlobal('fetch',fetcher);
  expect(await fetchLibrarySnapshot()).toMatchObject({total:96,remaining:2,sourceAt:'2026-10-16T11:24:20.000Z'});
  expect(fetcher).toHaveBeenCalledOnce();
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
