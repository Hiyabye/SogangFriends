import {createHmac,X509Certificate} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {rootCertificates} from 'node:tls';
import {SOURCES,collectNotices} from '../src/sources.ts';

export const CERTIFICATE_URL=new URL('../certificates/sogang-ov-r36.pem',import.meta.url);
export const CERTIFICATE_FINGERPRINT='6542D176BED50F193C0CE297AE44ECD8A0A86BEC2EDE682769344059B4E78530';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function verifyCertificate(pem=readFileSync(CERTIFICATE_URL),now=Date.now(),roots=rootCertificates) {
 const text=String(pem);const blocks=text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
 if(blocks?.length!==1||text.trim()!==blocks[0])throw new Error('Collector bundle must contain exactly one certificate');
 const cert=new X509Certificate(pem);
 if(!cert.ca||cert.fingerprint256.replaceAll(':','')!==CERTIFICATE_FINGERPRINT)throw new Error('Unexpected collector certificate');
 if(now<Date.parse(cert.validFrom)||now>Date.parse(cert.validTo))throw new Error('Collector certificate outside validity period');
 const trusted=roots.map(value=>new X509Certificate(value)).some(root=>cert.checkIssued(root)&&cert.verify(root.publicKey));
 if(!trusted)throw new Error('Collector certificate is not signed by a trusted root');
 return cert;
}
export function validateEndpoint(value) {
 let url;try{url=new URL(value);}catch{throw new Error('Invalid NOTICE_INGEST_URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/internal/notices')throw new Error('Invalid NOTICE_INGEST_URL');
 return url.href;
}
export function signedSnapshot(source,notices,secret,timestamp=String(Date.now())) {
 if(typeof secret!=='string'||secret.length<32)throw new Error('NOTICE_INGEST_SECRET must contain at least 32 characters');
 if(!/^\d{13}$/.test(timestamp))throw new Error('Invalid collector timestamp');
 if(!SOURCES.some(s=>s.id===source)||!Array.isArray(notices)||notices.length===0||notices.length>100)throw new Error('Invalid collector snapshot');
 const body=JSON.stringify({source,notices});
 if(Buffer.byteLength(body)>256*1024)throw new Error('Collector snapshot exceeds ingress size limit');
 return {body,headers:{'content-type':'application/json','x-collector-timestamp':timestamp,'x-collector-signature':createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}};
}
function retryDelay(response,attempt,now) {
 const value=response?.headers.get('retry-after');
 if(value){
  const seconds=/^\d+(?:\.\d+)?$/.test(value)?Number(value):(Date.parse(value)-now)/1000;
  // Never retry sooner than the server asks. Long waits belong to the next scheduled run.
  if(Number.isFinite(seconds)&&seconds>30)throw new Error('Ingress retry requested beyond bounded run');
  if(Number.isFinite(seconds)&&seconds>0)return seconds*1000;
 }
 return 1000*attempt;
}
export async function sendSnapshot(endpoint,snapshot,{fetcher=fetch,sleep=delay,now=Date.now}={}) {
 const url=validateEndpoint(endpoint);
 for(let attempt=1;attempt<=3;attempt++){
  let response;
  try{
   response=await fetcher(url,{method:'POST',redirect:'manual',headers:snapshot.headers,body:snapshot.body,signal:AbortSignal.timeout(20_000)});
  }catch{
   if(attempt===3)throw new Error('Ingress transport failed after bounded retries');
   await sleep(retryDelay(undefined,attempt,now()));continue;
  }
  // Only the acknowledgement status is needed; body cleanup must not replace it.
  await response.body?.cancel().catch(()=>{});
  if(response.status===202)return;
  if(response.status!==429&&response.status<500)throw new Error(`Ingress rejected snapshot (HTTP ${response.status})`);
  if(attempt===3)throw new Error(`Ingress unavailable after bounded retries (HTTP ${response.status})`);
  await sleep(retryDelay(response,attempt,now()));
 }
}
export async function runCollector({send=false,endpoint,secret,collect=collectNotices,sources=SOURCES,upload=sendSnapshot,log=console.log,archiveEnabled=false,capture}={}) {
 verifyCertificate();
 if(send){validateEndpoint(endpoint);if(typeof secret!=='string'||secret.length<32)throw new Error('NOTICE_INGEST_SECRET must contain at least 32 characters');}
 if(send&&archiveEnabled&&!capture){
  const {createArchiveClient,captureRawNotices}=await import('./notice-archive-client.mjs');
  const {collectNoticeRaw}=await import('../src/notice-archive-sources.ts');
  const client=createArchiveClient({endpoint,secret});
  // Recent polling retains the source module's one-second pacing; backfill adds slower spacing.
  capture=(source,notices)=>captureRawNotices(source,notices,{client,collectRaw:collectNoticeRaw,paceMs:0});
 }
 let failed=0;
 for(const source of sources){
  let stage='collect';
  try{
   const notices=await collect(source);
   if(send){
    if(archiveEnabled){stage='raw capture';const result=await capture(source,notices);if(result?.complete!==true)throw new Error('Raw capture incomplete');}
    stage='upload';await upload(endpoint,signedSnapshot(source.id,notices,secret));
   }
   log(`${source.id}: ${notices.length} notices ${send?'accepted':'collected (dry-run, not uploaded)'}`);
  }catch{
   failed++;log(`${source.id}: ${stage} failed; retained last-good stored data`);
  }
 }
 return failed===0?0:1;
}
export function validateCollectorLaunch(env) {
 if(env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error('TLS verification must remain enabled');
 if(!env.NODE_EXTRA_CA_CERTS||resolve(env.NODE_EXTRA_CA_CERTS)!==fileURLToPath(CERTIFICATE_URL))throw new Error('Launch with NODE_EXTRA_CA_CERTS=certificates/sogang-ov-r36.pem');
 verifyCertificate();
}
export async function main(args=process.argv.slice(2),env=process.env) {
 if(args.length>1||args.some(arg=>!['--send','--dry-run'].includes(arg)))throw new Error('Usage: npm run notices:collect -- [--dry-run | --send]');
 validateCollectorLaunch(env);
 return runCollector({send:args[0]==='--send',endpoint:env.NOTICE_INGEST_URL,secret:env.NOTICE_INGEST_SECRET,archiveEnabled:env.NOTICE_ARCHIVE_ENABLED==='true'});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().then(code=>{process.exitCode=code;}).catch(()=>{
  console.error('Collector startup failed; check arguments, certificate and ingress configuration. No secrets or upstream bodies are logged.');process.exitCode=1;
 });
}
