import type {DiscordMessageInput} from './discord';
/** Native Discord callout cards, not unsupported Obsidian/table markdown. */
export function mealCard(input:DiscordMessageInput):DiscordMessageInput{
 const text=typeof input==='string'?input:input.content;
 const footer='OCR 판독 결과로 메뉴명에 오탈자가 있을 수 있습니다. 미확인 항목은 원문을 확인하세요.';
 const files=typeof input==='string'?[]:input.files??(input.file?[input.file]:[]),used=new Set<string>();
 const embeds=text.replace(`\n${footer}`,'').split('\n\n').map((part,index)=>{
  const [title,...lines]=part.split('\n'),date=title.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const fields:{name:string;value:string;inline:boolean}[]=[],details:string[]=[];
  for(const line of lines){
   const match=line.match(/^(조식 한식|조식 양식·일품|조식 공통|석식):\s*(.+)$/);
   if(match)fields.push({name:match[1],value:match[2],inline:true});else details.push(line);
  }
  const file=files.find(file=>{const range=file.filename.match(/bellarmino-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})\./);return date&&range&&date>=range[1]&&date<=range[2];});
  const image=file&&!used.has(file.filename)?{url:`attachment://${file.filename}`}:undefined;
  if(file)used.add(file.filename);
  return {title,description:details.join('\n'),...(fields.length?{fields}:{}),color:index===0?0x5865f2:0x57f287,footer:{text:footer},...(image?{image}:{})};
 });
 return {content:'',embeds,...(files.length?{files}:{})};
}
