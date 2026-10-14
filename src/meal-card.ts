import type {DiscordCardComponent,DiscordMessageInput} from './discord';
/** Components V2 allows plain source/caution text below, outside the meal cards. */
export function mealCard(input:DiscordMessageInput):DiscordMessageInput{
 const text=typeof input==='string'?input:input.content;
 const footer='OCR 판독 결과로 메뉴명에 오탈자가 있을 수 있습니다. 미확인 항목은 원문을 확인하세요.';
 const files=typeof input==='string'?[]:input.files??(input.file?[input.file]:[]),used=new Set<string>(),sources=new Set<string>();
 const components:DiscordCardComponent[]=text.replace(`\n${footer}`,'').split('\n\n').map((part,index)=>{
  const [title,...lines]=part.split('\n'),date=title.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const details:string[]=[];
  for(const line of lines){
   if(line.startsWith('원문: ')){sources.add(line);continue;}
   const match=line.match(/^(조식 한식|조식 양식·일품|조식 공통|석식):\s*(.+)$/);
   details.push(match?`**${match[1]}**\n${match[2]}`:line);
  }
  const children:DiscordCardComponent[]=[{type:10,content:[`### ${title}`,...details].join('\n')}];
  const file=files.find(file=>{const range=file.filename.match(/bellarmino-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})\./);return date&&range&&date>=range[1]&&date<=range[2];});
  if(file&&!used.has(file.filename))children.push({type:12,items:[{media:{url:`attachment://${file.filename}`}}]});
  if(file)used.add(file.filename);
  return {type:17,accent_color:index===0?0x5865f2:0x57f287,components:children};
 });
 components.push({type:10,content:[...sources,footer].join('\n')});
 return {content:'',components,...(files.length?{files}:{})};
}
