import type {Source} from './types';

const boards:[string,string,number][]=[
 ['university','학사공지',2],
 ['universityStudent','학생 일반공지',34],
 ['universityScholarship','장학공지',141],
 ['universityGeneral','일반공지',1],
 ['universityEvent','행사특강',142],
 ['universityOnestop','Onestop Sogang 공지',3]
];
export const UNIVERSITY_NOTICE_SOURCES:Source[]=boards.map(([id,name,config])=>({id,name:`서강대학교 ${name}`,kind:'university',url:`https://www.sogang.ac.kr/api/api/v1/mainKo/BbsData/boardList?pageNum=1&pageSize=50&bbsConfigFk=${config}&category=&introPkId=&title=&content=&username=`}));
/** Bind the source identity and canonical board URL before trusting its config. */
export function universityBoardId(source:Source):number{
 const known=UNIVERSITY_NOTICE_SOURCES.find(s=>s.id===source.id&&s.kind===source.kind&&s.url===source.url);
 if(!known)throw new Error('Unknown university notice source');
 return Number(new URL(known.url).searchParams.get('bbsConfigFk'));
}
