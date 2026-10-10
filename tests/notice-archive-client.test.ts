import {describe,it,expect,vi} from 'vitest';
import {createHmac} from 'node:crypto';
import {createArchiveClient,captureRawNotices} from '../scripts/notice-archive-client.mjs';
import {runBackfill,parseBackfillArgs,main} from '../scripts/backfill-notices.mjs';
import {runCollector} from '../scripts/notice-collector.mjs';
import {SOURCES,SourceHttpError,sourceBytes} from '../src/sources';
const endpoint='https://bot.example/internal/notices',secret='fixture-secret-'.repeat(4);
const source=SOURCES[0],notice={source:source.id,id:'1',title:'검증용 공지',published:'2026-10-10',url:'https://www.sogang.ac.kr/ko/detail/1?bbsConfigFk=2'};
const raw={notice,bodyHtml:'<p>원문</p>',attachments:['https://example.test/file.pdf'],imageUrls:[]};
const sleep=async()=>{};
const json=(value:unknown)=>Response.json(value);

describe('archive transport and raw collection',()=>{
 it('derives the archive route, signs exact Korean bytes and reuses one signature across bounded retries',async()=>{
  const fetcher=vi.fn().mockRejectedValueOnce(new Error(secret)).mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(json({recorded:true,key:'raw/university/1.json'}));
  const pauses=vi.fn(sleep),client=createArchiveClient({endpoint,secret,fetcher,sleep:pauses,now:()=>1791561600000});
  await client({action:'record',raw});expect(fetcher).toHaveBeenCalledTimes(3);
  const initial=fetcher.mock.calls[0][1];
  expect(initial.headers['x-collector-signature']).toBe(createHmac('sha256',secret).update(`1791561600000.${initial.body}`).digest('hex'));
  for(const [url,options] of fetcher.mock.calls){expect(url).toBe('https://bot.example/internal/notice-archive');expect(options.body).toBe(initial.body);expect(options.headers).toEqual(initial.headers);expect(options.redirect).toBe('manual');}
  expect(pauses.mock.calls).toEqual([[1000],[2000]]);
 });
 it('rejects non-200 acknowledgements, redirects, unsafe endpoints and long retry-after',async()=>{
  for(const status of [202,302,401,409]){
   const fetcher=vi.fn(async()=>new Response(secret,{status})),client=createArchiveClient({endpoint,secret,fetcher,sleep});
   await expect(client({action:'status'})).rejects.toThrow(`HTTP ${status}`);expect(fetcher).toHaveBeenCalledTimes(1);
  }
  expect(()=>createArchiveClient({endpoint:'http://bot.example/internal/notices',secret})).toThrow('URL');
  expect(()=>createArchiveClient({endpoint,secret:'short'})).toThrow('32');
  const fetcher=vi.fn(async()=>new Response(null,{status:429,headers:{'retry-after':'300'}}));
  await expect(createArchiveClient({endpoint,secret,fetcher,sleep})({action:'status'})).rejects.toThrow('bounded run');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('caps transport attempts and request/acknowledgement sizes without leaking secrets',async()=>{
  const fetcher=vi.fn(async()=>{throw new Error(secret);});
  await expect(createArchiveClient({endpoint,secret,fetcher,sleep})({action:'status'})).rejects.toThrow('bounded retries');expect(fetcher).toHaveBeenCalledTimes(3);
  await expect(createArchiveClient({endpoint,secret,fetcher,sleep})({body:'x'.repeat(2*1024*1024)})).rejects.toThrow('size limit');
  const large=vi.fn(async()=>json({body:'x'.repeat(64*1024)}));
  await expect(createArchiveClient({endpoint,secret,fetcher:large,sleep})({action:'status'})).rejects.toThrow('bounded retries');expect(large).toHaveBeenCalledTimes(3);
 });
 it('captures only missing IDs, with no attachment downloads or model calls',async()=>{
  const client=vi.fn(async(payload:any)=>payload.action==='missing'?{missing:['1']}:{recorded:true,key:'raw/university/1.json'}),collectRaw=vi.fn(async()=>raw),pauses=vi.fn(sleep);
  const result=await captureRawNotices(source,[notice,{...notice,id:'2'}],{client,collectRaw,sleep:pauses});
  expect(result).toEqual({complete:true,captured:1});expect(collectRaw).toHaveBeenCalledTimes(1);expect(pauses).toHaveBeenCalledWith(3000);
  expect(client.mock.calls.map(([p])=>p.action)).toEqual(['missing','record']);expect(client.mock.calls[1][0].raw.attachments).toEqual(raw.attachments);
 });
 it('preserves source HTTP status and legacy message without mistaking parser errors for unavailability',async()=>{
  const stub=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(null,{status:404}));
  try{await expect(sourceBytes('https://www.sogang.ac.kr/ko/detail/1')).rejects.toMatchObject({name:'SourceHttpError',status:404,message:'Source HTTP 404'});}finally{stub.mockRestore();}
  const client=vi.fn(async()=>({missing:['1']}));
  for(const error of [new Error('Source HTTP 404'),new Error('Malformed HTML'),new SourceHttpError(503),new SourceHttpError(403),new Error('transport')]){
   await expect(captureRawNotices(source,[notice],{client,collectRaw:async()=>{throw error;},allowUnavailable:true,sleep})).rejects.toBe(error);
  }
  expect(client.mock.calls.every(([p])=>p.action==='missing')).toBe(true);
 });
 it('permits only explicitly enabled historical 404/410 skips and validates durable acknowledgements',async()=>{
  for(const status of [404,410]){
   const client=vi.fn(async(p:any)=>p.action==='missing'?{missing:['1']}:{unavailable:true,source:source.id,id:'1',status});
   const collectRaw=async()=>{throw new SourceHttpError(status);};
   await expect(captureRawNotices(source,[notice],{client,collectRaw,sleep})).rejects.toMatchObject({status});
   client.mockClear();
   expect(await captureRawNotices(source,[notice],{client,collectRaw,allowUnavailable:true,sleep})).toEqual({complete:true,captured:0,unavailable:1});
   expect(client.mock.calls.map(([p])=>p.action)).toEqual(['missing','unavailable']);
   expect(client.mock.calls[0][0].includeUnavailable).toBe(true);expect(client.mock.calls[1][0]).toEqual({action:'unavailable',notice,status});
  }
  const client=async(p:any)=>p.action==='missing'?{missing:['1']}:{unavailable:true,source:source.id,id:'wrong',status:404};
  await expect(captureRawNotices(source,[notice],{client,collectRaw:async()=>{throw new SourceHttpError(404);},allowUnavailable:true,sleep})).rejects.toThrow('unavailable acknowledgement');
 });
 it('fails closed for invalid missing-ID or record acknowledgements',async()=>{
  const collectRaw=vi.fn(async()=>raw);
  await expect(captureRawNotices(source,[notice],{client:async()=>({missing:['unrequested']}),collectRaw,sleep})).rejects.toThrow('missing-ID');expect(collectRaw).not.toHaveBeenCalled();
  await expect(captureRawNotices(source,[notice],{client:async(p:any)=>p.action==='missing'?{missing:['1']}:{recorded:true,key:'wrong'},collectRaw,sleep})).rejects.toThrow('record acknowledgement');
 });
});

describe('recent collector archive gate',()=>{
 it('keeps legacy uploads unchanged when archival is disabled',async()=>{
  const capture=vi.fn(),upload=vi.fn();
  expect(await runCollector({send:true,endpoint,secret,sources:[source],collect:async()=>[notice],upload,capture,log:vi.fn()})).toBe(0);
  expect(capture).not.toHaveBeenCalled();expect(upload).toHaveBeenCalledTimes(1);
 });
 it('saves raw before metadata and isolates a raw failure from later sources',async()=>{
  const events:string[]=[],sources=SOURCES.slice(0,2),upload=vi.fn(async()=>{events.push('upload');});
  const capture=vi.fn(async(s:any)=>{events.push('raw:'+s.id);if(s.id==='university')throw new Error(secret);return {complete:true};});
  const log=vi.fn();
  expect(await runCollector({send:true,endpoint,secret,archiveEnabled:true,sources,collect:async(s:any)=>[{...notice,source:s.id}],upload,capture,log})).toBe(1);
  expect(events).toEqual(['raw:university','raw:academicNotice','upload']);expect(upload).toHaveBeenCalledTimes(1);expect(log.mock.calls.flat().join('\n')).not.toContain(secret);
 });
 it('does not archive on collector dry-run even with archive enabled',async()=>{
  const capture=vi.fn(),upload=vi.fn();
  expect(await runCollector({archiveEnabled:true,sources:[source],collect:async()=>[notice],capture,upload,log:vi.fn()})).toBe(0);
  expect(capture).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
 });
});

describe('bounded resumable backfill',()=>{
 const collectPage=async()=>({notices:[notice],done:false}),collectRaw=async()=>raw;
 it('defaults to dry-run and checks only one first page without archive calls',async()=>{
  expect(parseBackfillArgs([])).toEqual({send:false,start:false,pages:1});expect(parseBackfillArgs(['--send','--start','--pages','2'])).toEqual({send:true,start:true,pages:2});
  for(const args of [['--start'],['--send','--dry-run'],['--pages','0'],['--pages','7'],['--unknown']])expect(()=>parseBackfillArgs(args)).toThrow();
  const client=vi.fn(),page=vi.fn(collectPage),record=vi.fn(collectRaw);
  expect(await runBackfill({pages:6,client,collectPage:page,collectRaw:record,sleep,log:vi.fn()})).toBe(0);
  expect(client).not.toHaveBeenCalled();expect(page).toHaveBeenCalledTimes(1);expect(page).toHaveBeenCalledWith(source,1);expect(record).toHaveBeenCalledTimes(1);
 });
 it('requires explicit send, enablement and verified TLS launch for actual uploads',async()=>{
  await expect(main(['--send'],{NODE_TLS_REJECT_UNAUTHORIZED:'0'})).rejects.toThrow('TLS');
  await expect(main(['--send'],{})).rejects.toThrow('NODE_EXTRA_CA_CERTS');
  const {CERTIFICATE_URL}=await import('../scripts/notice-collector.mjs');
  await expect(main(['--send'],{NODE_EXTRA_CA_CERTS:CERTIFICATE_URL.pathname,NOTICE_INGEST_URL:endpoint,NOTICE_INGEST_SECRET:secret})).rejects.toThrow('ENABLED');
 });
 it('initializes only on explicit start and commits after durable records',async()=>{
  const actions:string[]=[];let page=1;
  const client=async(p:any)=>{actions.push(p.action);if(p.action==='start')return {started:true};if(p.action==='status')return {sources:[{source:'university',page,state:'active'}]};if(p.action==='missing')return {missing:['1']};if(p.action==='record')return {recorded:true,key:'raw/university/1.json'};return {committed:true,page:++page,state:'active'};};
  expect(await runBackfill({send:true,start:true,pages:1,client,collectPage,collectRaw,sleep,log:vi.fn()})).toBe(0);
  expect(actions).toEqual(['start','status','missing','record','commit']);
  actions.length=0;
  await runBackfill({send:true,pages:1,client,collectPage,collectRaw,sleep,log:vi.fn()});expect(actions).not.toContain('start');
 });
 it('rotates across source cursors and stops on terminal state without requesting the next page',async()=>{
  const sources=SOURCES.slice(0,2),state=sources.map(s=>({source:s.id,page:1,state:'active'})),pagesRead:string[]=[];
  const client=async(p:any)=>{if(p.action==='status')return {sources:state.map(s=>({...s}))};if(p.action==='missing')return {missing:[]};if(p.action==='commit'){const row=state.find(s=>s.source===p.source)!;row.page++;row.state='done';return {committed:true,page:row.page,state:row.state};}throw new Error('Unexpected action');};
  const read=async(s:any,page:number)=>{pagesRead.push(`${s.id}:${page}`);return {notices:[{...notice,source:s.id}],done:true};};
  expect(await runBackfill({send:true,pages:6,client,sources,collectPage:read,collectRaw,sleep,log:vi.fn()})).toBe(0);
  expect(pagesRead).toEqual(['university:1','academicNotice:1']);
 });
 it('never commits a failed detail/page and does not treat an exception as EOF',async()=>{
  const client=vi.fn(async(p:any)=>p.action==='status'?{sources:[{source:'university',page:4,state:'active'}]}:{missing:['1']});
  expect(await runBackfill({send:true,pages:1,client,collectPage,collectRaw:async()=>{throw new Error(secret);},sleep,log:vi.fn()})).toBe(1);
  expect(client.mock.calls.some(([p])=>p.action==='commit')).toBe(false);
  client.mockClear();
  expect(await runBackfill({send:true,pages:1,client,collectPage:async()=>{throw new Error('Malformed page');},collectRaw,sleep,log:vi.fn()})).toBe(1);
  expect(client.mock.calls.map(([p])=>p.action)).toEqual(['status']);
 });
 it('keeps a 503 page pending while allowing another board to finish',async()=>{
  const sources=SOURCES.slice(0,2),cursors=sources.map(s=>({source:s.id,page:1,state:'active'}));
  const actions:any[]=[];
  const client=async(p:any)=>{actions.push(p);if(p.action==='status')return {sources:cursors.map(c=>({...c}))};if(p.action==='missing')return {missing:['1']};if(p.action==='record')return {recorded:true,key:`raw/${p.raw.notice.source}/1.json`};if(p.action==='commit'){const c=cursors.find(c=>c.source===p.source)!;c.page++;c.state='done';return {committed:true,page:c.page,state:c.state};}throw new Error('Unexpected action');};
  const read=async(s:any)=>({notices:[{...notice,source:s.id}],done:true});
  const detail=async(n:any)=>{if(n.source==='university')throw new SourceHttpError(503);return {...raw,notice:n};};
  expect(await runBackfill({send:true,pages:6,client,sources,collectPage:read,collectRaw:detail,sleep,log:vi.fn()})).toBe(1);
  expect(cursors).toEqual([{source:'university',page:1,state:'active'},{source:'academicNotice',page:2,state:'done'}]);
  expect(actions.filter(p=>p.action==='commit').map(p=>p.source)).toEqual(['academicNotice']);
  expect(actions.some(p=>p.action==='unavailable')).toBe(false);
 });
 it('pauses between records at the runtime budget without advancing the cursor',async()=>{
  let clock=0;const client=vi.fn(async(p:any)=>p.action==='status'?{sources:[{source:'university',page:1,state:'active'}]}:p.action==='missing'?{missing:['1','2']}:{recorded:true,key:'raw/university/1.json'});
  const read=async()=>({notices:[notice,{...notice,id:'2'}],done:false}),body=vi.fn(async()=>{clock=11;return raw;});
  expect(await runBackfill({send:true,pages:1,client,collectPage:read,collectRaw:body,sleep,now:()=>clock,maxMs:10,log:vi.fn()})).toBe(0);
  expect(body).toHaveBeenCalledTimes(1);expect(client.mock.calls.some(([p])=>p.action==='commit')).toBe(false);
 });
});
