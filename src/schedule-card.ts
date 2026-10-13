import type { Schedule } from './types';
import type { DiscordMessageInput } from './discord';
import { dayDifference, todayKst, validDate } from './time';

const clean = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/[\\*_`~|<>\[\]]/g, '\\$&');
const countdown = (today: string, date: string) => dayDifference(today, date) === 0 ? 'D-day' : `D-${dayDifference(today, date)}`;
const footer = '날짜 기준 D-day입니다. 세부 운영 시각과 변경 사항은 공식 원문을 확인하세요.';

/** All approved student-facing schedules remain visible, inline or in the complete file. */
export function scheduleCard(items: Schedule[], today: string): DiscordMessageInput {
 if (!validDate(today)) throw new Error('Invalid summary date');
 const deadline = (item: Schedule) => item.deadlineDate ?? (item.deadlineAt ? todayKst(new Date(item.deadlineAt)) : undefined);
 const entries = items.filter(item => item.active === true && !item.note.includes('교직원 대상') && (item.endDate ?? deadline(item) ?? item.startDate) >= today)
  .sort((a,b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
 const rows = entries.map(item => {
  const end = deadline(item);
  const phase = item.type === 'deadline' ? `마감 ${countdown(today, end!)}`
   : item.startDate < today ? `진행 중${end && end >= today ? ` · 마감 ${countdown(today,end)}` : ''}` : countdown(today,item.startDate);
  const dates = item.type === 'deadline' ? end! : `${item.startDate}${item.endDate ? ` ~ ${item.endDate}` : ''}`;
  const details = [dates,
   ...(item.type === 'period' && end ? [`마감: ${end}${end >= today ? ` (${countdown(today,end)})` : ' (지남)'}`] : []),
   ...(item.note ? [clean(item.note)] : []),
   ...(item.deadlineAt ? [`명시된 마감: ${item.deadlineAt}`] : [])];
  return { name: `${phase} · ${clean(item.title)}`, value: [...details,`[공식 원문](<${item.sourceUrl}>)`].join('\n'),
   text: `• ${phase} | ${dates} | ${clean(item.title)}${details.slice(1).map(line=>`\n  ${line}`).join('')}` };
 });
 const title = `학사일정 · ${today} KST 기준`;
 const description = entries.length ? `승인된 일정 ${entries.length}개 · 날짜 기준` : '앞으로의 승인된 학사일정이 없습니다.';
 const fields = rows.map(({name,value})=>({name,value,inline:false}));
 const length = title.length + description.length + footer.length + fields.reduce((sum,field)=>sum+field.name.length+field.value.length,0);
 const fits = fields.length <= 25 && fields.every(field=>field.name.length<=256 && field.value.length<=1024) && length<=6000;
 if (fits) return {content:'',embeds:[{title,description,color:0x5865f2,...(fields.length?{fields}:{}),footer:{text:footer}}]};
 const sources = [...new Set(entries.map(item=>item.sourceUrl))].map(url=>`<${url}>`);
 const full = `${title}\n${rows.map(row=>row.text).join('\n')}\n\n공식 원문\n${sources.join('\n')}\n${footer}`;
 return {content:'',embeds:[{title,description:`승인된 앞으로의 일정 ${entries.length}개를 전체 일정 파일로 첨부합니다.`,color:0x5865f2,footer:{text:footer}}],
  file:{filename:`schedule-${today}.txt`,bytes:new TextEncoder().encode(full),mime:'text/plain; charset=utf-8'}};
}
