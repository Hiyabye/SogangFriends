import {describe,expect,it} from 'vitest';
import {mealCard} from '../src/meal-card';
import {message} from '../src/discord';
const footer='OCR 판독 결과로 메뉴명에 오탈자가 있을 수 있습니다. 미확인 항목은 원문을 확인하세요.';
const part=(title:string,url='https://school.example/menu')=>`${title}\n조식 한식: 밥 / 국\n조식 공통: 확인 불가 / 미기재\n원문: <${url}>`;
describe('meal components',()=>{
 it('puts deduplicated source links and the exact warning after all containers',()=>{
  const body=message(mealCard(`${part('오늘 아침 (2026-10-13)')}\n\n${part('오늘 저녁 (2026-10-13)')}\n${footer}`));
  expect(body.flags).toBe(32768);expect(body).not.toHaveProperty('content');expect(body).not.toHaveProperty('embeds');expect(body.allowed_mentions.parse).toEqual([]);
  expect(body.components?.map(component=>component.type)).toEqual([17,17,10]);
  for(const card of body.components!.slice(0,2)){expect(JSON.stringify(card)).not.toContain('원문:');expect(JSON.stringify(card)).not.toContain(footer);}
  expect(body.components!.at(-1)).toEqual({type:10,content:`원문: <https://school.example/menu>\n${footer}`});
  expect(JSON.stringify(body)).toContain('밥 / 국');expect(JSON.stringify(body)).toContain('미기재');
 });
 it('exposes two-week attachments once each and keeps both sources outside',()=>{
  const files=['2026-10-12-2026-10-18','2026-10-19-2026-10-25'].map(range=>({filename:`bellarmino-${range}.png`,bytes:new Uint8Array([1]),mime:'image/png'}));
  const body=message(mealCard({content:`${part('오늘 저녁 (2026-10-18)')}\n\n${part('내일 아침 (2026-10-19)','https://school.example/next')}\n${footer}`,files}));
  expect(body.attachments).toEqual(files.map((file,id)=>({id,filename:file.filename})));
  for(const [index,card] of body.components!.slice(0,2).entries()){
   expect(card.type).toBe(17);if(card.type!==17)throw new Error('Expected container');
   expect(card.components[1]).toEqual({type:12,items:[{media:{url:`attachment://${files[index].filename}`}}]});
  }
  expect(body.components!.at(-1)).toEqual({type:10,content:`원문: <https://school.example/menu>\n원문: <https://school.example/next>\n${footer}`});
 });
 it('deduplicates an image shared by two meal cards',()=>{
  const file={filename:'bellarmino-2026-10-12-2026-10-18.png',bytes:new Uint8Array([1]),mime:'image/png'};
  const body=message(mealCard({content:`${part('오늘 아침 (2026-10-13)')}\n\n${part('오늘 저녁 (2026-10-13)')}\n${footer}`,file}));
  expect(JSON.stringify(body.components).match(/attachment:\/\//g)).toHaveLength(1);
 });
});
