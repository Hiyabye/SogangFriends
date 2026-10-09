import {describe,it,expect,vi} from 'vitest';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {verifyCertificate,validateEndpoint,signedSnapshot,sendSnapshot,runCollector,main,CERTIFICATE_URL,CERTIFICATE_FINGERPRINT} from '../scripts/notice-collector.mjs';
import {SOURCES} from '../src/sources';
const endpoint='https://bot.example/internal/notices';
const secret='fixture-secret-'.repeat(4);
const row={id:'1',source:'university',title:'검증용 공지 😀',published:'2026-10-09',url:'https://www.sogang.ac.kr/ko/detail/1?bbsConfigFk=2'};
const snapshot=()=>signedSnapshot('university',[row],secret,'1791561600000');

describe('standalone authenticated notice collector',()=>{
 it('pins the official CA fingerprint, verifies root signature and enforces validity',()=>{
  const cert=verifyCertificate();expect(cert.fingerprint256.replaceAll(':','')).toBe(CERTIFICATE_FINGERPRINT);expect(cert.ca).toBe(true);
  const pem=readFileSync(CERTIFICATE_URL);
  expect(()=>verifyCertificate(pem,Date.parse('2040-01-01'))).toThrow('validity');
  expect(()=>verifyCertificate(pem,Date.parse('2020-01-01'))).toThrow('validity');
  expect(()=>verifyCertificate(pem,Date.now(),[])).toThrow('trusted root');
  expect(()=>verifyCertificate('not a certificate')).toThrow();
  expect(()=>verifyCertificate(Buffer.concat([pem,pem]))).toThrow('exactly one');
  expect(()=>verifyCertificate(String(pem)+'\n-----BEGIN PRIVATE KEY-----\nextra\n-----END PRIVATE KEY-----')).toThrow('exactly one');
 });
 it('allows HTTPS ingress only without credentials, query or redirects',()=>{
  expect(validateEndpoint(endpoint)).toBe(endpoint);
  for(const url of ['http://bot.example/internal/notices','https://user:pass@bot.example/internal/notices','https://bot.example/other','https://bot.example/internal/notices?key=secret','https://bot.example/internal/notices#part','not a URL'])expect(()=>validateEndpoint(url)).toThrow('NOTICE_INGEST_URL');
 });
 it('signs exact UTF-8 snapshot bytes and refuses invalid source, timestamp and weak secret',()=>{
  const s=snapshot();expect(JSON.parse(s.body)).toEqual({source:'university',notices:[row]});
  expect(s.headers['x-collector-signature']).toBe(createHmac('sha256',secret).update(`1791561600000.${s.body}`).digest('hex'));
  expect(s.headers['x-collector-timestamp']).toBe('1791561600000');
  expect(()=>signedSnapshot('university',[row],'short')).toThrow('32');
  expect(()=>signedSnapshot('unknown',[row],secret)).toThrow('snapshot');
  expect(()=>signedSnapshot('university',[row],secret,'bad')).toThrow('timestamp');
  expect(()=>signedSnapshot('university',[],secret)).toThrow('snapshot');
  expect(()=>signedSnapshot('university',Array(101).fill(row),secret)).toThrow('snapshot');
  expect(()=>signedSnapshot('university',[{...row,title:'a'.repeat(256*1024)}],secret)).toThrow('size');
 });
 it('retries transport and server failure with identical signed bytes, then accepts 202',async()=>{
  const fetcher=vi.fn().mockRejectedValueOnce(new Error('private transport details')).mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(new Response(null,{status:202}));
  const sleep=vi.fn(async()=>{});const s=snapshot();
  await sendSnapshot(endpoint,s,{fetcher,sleep});expect(fetcher).toHaveBeenCalledTimes(3);expect(sleep.mock.calls).toEqual([[1000],[2000]]);
  for(const [,options] of fetcher.mock.calls){expect(options.body).toBe(s.body);expect(options.headers).toEqual(s.headers);expect(options.redirect).toBe('manual');expect(options.signal).toBeInstanceOf(AbortSignal);}
 });
 it('honors short retry-after and stops rather than retrying before a long requested wait',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{status:429,headers:{'retry-after':'10'}})).mockResolvedValueOnce(new Response(null,{status:202}));const sleep=vi.fn(async()=>{});
  await sendSnapshot(endpoint,snapshot(),{fetcher,sleep});expect(sleep).toHaveBeenCalledWith(10_000);
  const long=vi.fn(async()=>new Response(null,{status:429,headers:{'retry-after':'300'}}));
  await expect(sendSnapshot(endpoint,snapshot(),{fetcher:long,sleep})).rejects.toThrow('bounded run');expect(long).toHaveBeenCalledTimes(1);
 });
 it('does not retry redirects or authentication failures, follow location, or log error bodies',async()=>{
  for(const status of [301,302,401,403,400,200]){
   const fetcher=vi.fn(async()=>new Response('sensitive upstream error body',{status,headers:{location:'https://evil.example'}}));
   await expect(sendSnapshot(endpoint,snapshot(),{fetcher,sleep:vi.fn()})).rejects.toThrow(`HTTP ${status}`);expect(fetcher).toHaveBeenCalledTimes(1);
  }
 });
 it('bounds retries at three attempts without leaking transport exceptions',async()=>{
  const fetcher=vi.fn(async()=>{throw new Error(secret);});
  await expect(sendSnapshot(endpoint,snapshot(),{fetcher,sleep:vi.fn(async()=>{})})).rejects.toThrow('bounded retries');expect(fetcher).toHaveBeenCalledTimes(3);
 });
 it('defaults to a no-upload dry run and keeps later sources running after a failure',async()=>{
  const collect=vi.fn(async(source:any)=>{if(source.id==='university')throw new Error('Author name and private upstream body');return [{...row,source:source.id}];});const upload=vi.fn();const log=vi.fn();
  expect(await runCollector({collect,upload,log})).toBe(1);expect(collect).toHaveBeenCalledTimes(6);expect(upload).not.toHaveBeenCalled();
  expect(log.mock.calls.flat().join('\n')).not.toContain('Author');expect(log.mock.calls.flat().join('\n')).toContain('dry-run');
 });
 it('isolates upload failures and requires complete send configuration before collection',async()=>{
  const collect=vi.fn(async(source:any)=>[{...row,source:source.id}]);const upload=vi.fn().mockRejectedValueOnce(new Error(secret)).mockResolvedValue(undefined);const log=vi.fn();
  expect(await runCollector({send:true,endpoint,secret,collect,upload,log})).toBe(1);expect(upload).toHaveBeenCalledTimes(6);expect(log.mock.calls.flat().join('\n')).not.toContain(secret);
  const unused=vi.fn();await expect(runCollector({send:true,endpoint,secret:'short',collect:unused})).rejects.toThrow('32');expect(unused).not.toHaveBeenCalled();
  await expect(runCollector({send:true,endpoint:'http://unsafe',secret,collect:unused})).rejects.toThrow('URL');expect(unused).not.toHaveBeenCalled();
 });
 it('covers exactly the six approved source IDs and rejects insecure CLI launch settings',async()=>{
  expect(SOURCES.map(s=>s.id)).toEqual(['university','academicNotice','graduateNotice','externalInfo','news','career']);
  await expect(main(['--unknown'],{})).rejects.toThrow('Usage');
  await expect(main(['--send','--dry-run'],{})).rejects.toThrow('Usage');
  await expect(main([], {NODE_TLS_REJECT_UNAUTHORIZED:'0'})).rejects.toThrow('TLS verification');
  await expect(main([],{})).rejects.toThrow('NODE_EXTRA_CA_CERTS');
 });
});
