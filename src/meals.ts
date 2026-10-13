import type { MealWeek, MealDay, Offering } from './types';

const fields = ['breakfastKorean','breakfastWestern','breakfastCommon','cupRice','dinner','drinks'] as const;
interface Expected {start:string;end:string;published:string}
function validDate(value:unknown):value is string {return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function object(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid meal object');return value as Record<string,unknown>;}
function keys(value:Record<string,unknown>,names:readonly string[]):void {if(Object.keys(value).length!==names.length||names.some(n=>!Object.hasOwn(value,n)))throw new Error('Unexpected meal fields');}
function offering(value:unknown,cup:boolean):Offering {
 const o=object(value);keys(o,['status','items','time','evidence']);
 if(!['available','closed','unknown'].includes(String(o.status))||!Array.isArray(o.items)||o.items.length>20||o.items.some(x=>typeof x!=='string'||!x.trim()||x.length>150)||typeof o.evidence!=='string'||o.evidence.length>500||!(o.time===null||(typeof o.time==='string'&&o.time.length<=100)))throw new Error('Invalid meal offering');
 if(o.status==='available'&&(!o.items.length||!o.evidence.trim()))throw new Error('Available meal lacks evidence');
 if(o.status!=='available'&&(o.items.length||o.time!==null))throw new Error('Unavailable meal has menu');
 if(o.status==='closed'&&!o.evidence.trim())throw new Error('Closure lacks explicit evidence');
 if(cup&&o.status==='available'&&o.time!==null&&!o.evidence.includes(String(o.time)))throw new Error('Cup rice time lacks evidence');
 return {status:o.status as Offering['status'],items:o.items as string[],time:o.time as string|null,evidence:o.evidence};
}
/** Validate observed identities before sorting. Never assign a date from array position. */
export function validateMeal(value:unknown,expected:Expected):MealWeek {
 if(!validDate(expected.start)||!validDate(expected.end)||!validDate(expected.published)||(Date.parse(expected.end)-Date.parse(expected.start))/86400000!==6||new Date(expected.start).getUTCDay()!==1||Math.abs(Date.parse(expected.start)-Date.parse(expected.published))>45*86400000)throw new Error('Invalid source meal period');
 const v=object(value);keys(v,['start','end','certain','days']);
 if(v.start!==expected.start||v.end!==expected.end||v.certain!==true||!Array.isArray(v.days)||v.days.length!==7)throw new Error('Uncertain or conflicting meal period');
 const seen=new Set<string>();const days:MealDay[]=[];
 for(const raw of v.days){const d=object(raw);keys(d,['date','weekday',...fields]);
  if(!validDate(d.date)||d.date<expected.start||d.date>expected.end||seen.has(d.date)||typeof d.weekday!=='number'||!Number.isInteger(d.weekday)||d.weekday!==((new Date(d.date).getUTCDay()+6)%7)+1)throw new Error('Invalid observed date or weekday');
  seen.add(d.date);const result={date:d.date,weekday:d.weekday} as MealDay;for(const f of fields)result[f]=offering(d[f],f==='cupRice');days.push(result);
 }
 return {start:expected.start,end:expected.end,certain:true,days:days.sort((a,b)=>a.date.localeCompare(b.date))};
}
interface Identity {image_hash:string;version:string;source_url:string;start_date:string;end_date:string}
export function reusableMeal(row:Identity,identity:Identity):boolean {return ['image_hash','version','source_url','start_date','end_date'].every(k=>row[k as keyof Identity]===identity[k as keyof Identity]);}
function clip(text:string,limit:number):string {
 if(text.length<=limit)return text;
 let result='';for(const char of text){if(result.length+char.length>limit-1)break;result+=char;}return result+'…';
}
function display(label:string,o:Offering,budget:number):string {
 const prefix=`${label}: `;
 if(o.status!=='available')return prefix+(o.status==='closed'?'미운영':'확인 불가 / 미기재');
 const time=o.time?` (${o.time})`:'';
 const suffix=' … (일부 생략; 원문 확인)';
 let menu=o.items.join(', ');
 if(prefix.length+menu.length+time.length>budget)menu=clip(menu,Math.max(1,budget-prefix.length-time.length-suffix.length))+suffix;
 return prefix+menu+time;
}
export function formatMeal(week:MealWeek,date:string,sourceUrl:string):string {
 if(sourceUrl.length>1000)throw new Error('Meal source URL too long');
 const day=validDate(date)&&week.certain&&date>=week.start&&date<=week.end?week.days.find(d=>d.date===date):undefined;
 if(!day)return `${validDate(date)?date:'지정 날짜'} 식단 확인 불가\n원문: <${sourceUrl}>`;
 const heading=`${date} 벨라르미노 식단`,source=`원문: <${sourceUrl}>`;
 const caution='OCR 판독 결과로 메뉴명에 오탈자가 있을 수 있습니다. 미확인 항목과 정확한 메뉴는 원문을 확인하세요.';
 const entries:[string,Offering][]=[['조식 한식',day.breakfastKorean],['조식 양식·일품',day.breakfastWestern],['석식',day.dinner]];
 if(day.cupRice.status==='available')entries.push(['컵밥',day.cupRice]);
 const budget=Math.floor((2000-heading.length-source.length-caution.length-entries.length-2)/entries.length);
 if(budget<160)throw new Error('Meal source URL too long');
 return [heading,...entries.map(([label,o])=>display(label,o,budget)),caution,source].join('\n');
}
