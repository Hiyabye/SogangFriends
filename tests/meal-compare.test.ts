import {it,expect,vi} from 'vitest';
import {handleRequest} from '../src/worker';
import {testDatabase} from './helpers/db';

it('returns Gone for the retired comparison route without modifying historical jobs or reservations',async()=>{
 const db=testDatabase();try{
  db.sqlite.exec("INSERT INTO jobs(id,kind,payload,state,attempts,created_at,available_at) VALUES('trial','meal-extract','{\"historical\":true}','needs_review',2,'old','old'); INSERT INTO llm_usage(id,day,reserved_usd,state,created_at) VALUES('trial','2026-10-11',.25,'reserved','old')");
  const jobs=db.sqlite.prepare('SELECT * FROM jobs').all(),usage=db.sqlite.prepare('SELECT * FROM llm_usage').all();
  const network=vi.spyOn(globalThis,'fetch');
  const response=await handleRequest(new Request('https://bot.test/internal/meal-compare',{method:'POST',body:'{}'}),db.env);
  expect(response.status).toBe(410);expect(network).not.toHaveBeenCalled();expect(db.env.JOBS.send).not.toHaveBeenCalled();
  expect(db.sqlite.prepare('SELECT * FROM jobs').all()).toEqual(jobs);expect(db.sqlite.prepare('SELECT * FROM llm_usage').all()).toEqual(usage);
 }finally{db.close();vi.restoreAllMocks();}
});
