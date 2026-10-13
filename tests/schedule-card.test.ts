import {describe,expect,it} from 'vitest';
import {scheduleCard} from '../src/schedule-card';
import type {Schedule} from '../src/types';
import type {DiscordMessageInput} from '../src/discord';

const entry=(changes:Partial<Schedule>={}):Schedule=>({id:'exam',title:'중간시험',startDate:'2026-10-20',endDate:'2026-10-26',type:'period',sourceUrl:'https://www.sogang.ac.kr/ko/academic-support/calendar',lastReviewed:'2026-10-09',note:'',active:true,...changes});
function output(input:DiscordMessageInput){if(typeof input==='string')throw new Error('Expected embed card');return input;}
function text(input:DiscordMessageInput){return JSON.stringify(input);}
function full(input:DiscordMessageInput){return new TextDecoder().decode(output(input).file!.bytes);}
function bounds(input:DiscordMessageInput){
 const embed=output(input).embeds![0] as {title:string;description:string;fields?:{name:string;value:string;inline:boolean}[];footer:{text:string}};
 expect(embed.title.length).toBeLessThanOrEqual(256);expect(embed.description.length).toBeLessThanOrEqual(4096);
 const fields=embed.fields??[];expect(fields.length).toBeLessThanOrEqual(25);
 for(const field of fields){expect(field.name.length).toBeLessThanOrEqual(256);expect(field.value.length).toBeLessThanOrEqual(1024);expect(field.inline).toBe(false);}
 expect(embed.title.length+embed.description.length+embed.footer.text.length+fields.reduce((sum,field)=>sum+field.name.length+field.value.length,0)).toBeLessThanOrEqual(6000);
}

describe('academic schedule embed card',()=>{
 it('includes approved student schedules, ongoing deadlines and far future; sorts chronologically',()=>{
  const input=scheduleCard([
   entry({id:'far',title:'먼 일정',startDate:'2027-02-18',endDate:undefined,type:'event'}),
   entry({id:'today',title:'오늘 일정',startDate:'2026-10-11',endDate:undefined,type:'event'}),
   entry({id:'ongoing',title:'진행 중 일정',startDate:'2026-10-01',deadlineDate:'2026-10-20'}),
   entry({id:'inactive',title:'승인 전',active:false}),entry({id:'faculty',title:'교직원',note:'교직원 대상'}),
   entry({id:'past',title:'지난 일정',startDate:'2026-10-01',endDate:'2026-10-10'})
  ],'2026-10-11');
  const rendered=text(input);expect(rendered).toContain('진행 중 · 마감 D-9');expect(rendered).toContain('D-day · 오늘 일정');expect(rendered).toContain('먼 일정');
  expect(rendered).not.toContain('승인 전');expect(rendered).not.toContain('교직원');expect(rendered).not.toContain('지난 일정');
  expect(rendered.indexOf('진행 중 일정')).toBeLessThan(rendered.indexOf('오늘 일정'));expect(rendered.indexOf('오늘 일정')).toBeLessThan(rendered.indexOf('먼 일정'));
  expect(rendered).toContain('2026-10-11 KST');bounds(input);expect(output(input).file).toBeUndefined();
 });
 it('sorts matching start dates by official schedule identity',()=>{
  const rendered=text(scheduleCard([entry({id:'z',title:'뒤 일정'}),entry({id:'a',title:'앞 일정'})],'2026-10-11'));
  expect(rendered.indexOf('앞 일정')).toBeLessThan(rendered.indexOf('뒤 일정'));
 });
 it('does not invent a deadline from a period end',()=>{
  const rendered=text(scheduleCard([entry({startDate:'2026-10-01'})],'2026-10-11'));
  expect(rendered).toContain('진행 중 · 중간시험');expect(rendered).not.toContain('마감 D-');expect(rendered).toContain('2026-10-01 ~ 2026-10-26');
 });
 it('derives deadline day in KST while retaining the explicit time and exact official URL',()=>{
  const time='2026-10-10T15:30:00Z';const input=scheduleCard([entry({type:'deadline',startDate:'2026-10-01',endDate:undefined,deadlineAt:time})],'2026-10-11');
  const rendered=text(input);expect(rendered).toContain('마감 D-day');expect(rendered).toContain('2026-10-11');expect(rendered).toContain(`명시된 마감: ${time}`);expect(rendered).toContain(`[공식 원문](<${entry().sourceUrl}>)`);bounds(input);
  expect(text(scheduleCard([entry({type:'deadline',endDate:undefined,deadlineAt:time})],'2026-10-12'))).toContain('승인된 학사일정이 없습니다');
 });
 it('preserves an already-passed explicit deadline on an ongoing period',()=>{
  const rendered=text(scheduleCard([entry({startDate:'2026-10-01',deadlineDate:'2026-10-10'})],'2026-10-11'));
  expect(rendered).toContain('진행 중 · 중간시험');expect(rendered).toContain('마감: 2026-10-10 (지남)');expect(rendered).not.toContain('D--');
 });
 it('escapes source text markup and normalizes newlines without dropping notes',()=>{
  const input=scheduleCard([entry({title:'*수강* [정정]\n안내',note:'`학부`\n확인 _필수_'})],'2026-10-11');
  const embed=output(input).embeds![0] as {fields:{name:string;value:string}[]};
  expect(embed.fields[0].name).toContain('\\*수강\\* \\[정정\\] 안내');expect(embed.fields[0].value).toContain('\\`학부\\` 확인 \\_필수\\_');bounds(input);
 });
 it('shows an empty card and rejects invalid date-only values',()=>{
  const input=scheduleCard([],'2026-10-11');expect(text(input)).toContain('앞으로의 승인된 학사일정이 없습니다.');bounds(input);
  expect(()=>scheduleCard([],'2026-02-30')).toThrow('Invalid summary date');
 });
 it('attaches the entire schedule, not a partial list, when count exceeds 25 fields',()=>{
  const entries=Array.from({length:26},(_,i)=>entry({id:String(i),title:`일정 ${i}`}));const input=scheduleCard(entries,'2026-10-11');
  expect(output(input).file!.filename).toBe('schedule-2026-10-11.txt');expect(output(input).content.length).toBeLessThanOrEqual(2000);
  for(let i=0;i<26;i++)expect(full(input)).toContain(`일정 ${i}`);expect(full(input)).toContain(`<${entry().sourceUrl}>`);expect(full(input)).toContain('날짜 기준 D-day');bounds(input);
 });
 it('uses complete file fallback for an overlong field name instead of truncating its title',()=>{
  const title='긴 일정'.repeat(100);const input=scheduleCard([entry({title})],'2026-10-11');expect(full(input)).toContain(title);bounds(input);
 });
 it('uses complete file fallback for an overlong value/link without dropping either',()=>{
  const note='안내'.repeat(600),sourceUrl=`https://www.sogang.ac.kr/ko/calendar?reference=${'a'.repeat(1100)}`;
  const input=scheduleCard([entry({note,sourceUrl})],'2026-10-11');expect(full(input)).toContain(note);expect(full(input)).toContain(`<${sourceUrl}>`);bounds(input);
 });
 it('enforces total embed characters even when every field fits individually',()=>{
  const input=scheduleCard(Array.from({length:20},(_,i)=>entry({id:String(i),title:`일정 ${i}`,note:'안내'.repeat(180)})),'2026-10-11');
  expect(output(input).file).toBeDefined();for(let i=0;i<20;i++)expect(full(input)).toContain(`일정 ${i}`);bounds(input);
 });
 it('allows exactly 25 concise fields and retains every source link',()=>{
  const input=scheduleCard(Array.from({length:25},(_,i)=>entry({id:String(i),title:`일정 ${i}`})),'2026-10-11');
  expect(output(input).file).toBeUndefined();const embed=output(input).embeds![0] as {fields:{name:string;value:string}[]};expect(embed.fields).toHaveLength(25);
  for(const field of embed.fields)expect(field.value).toContain(entry().sourceUrl);bounds(input);
 });
});
