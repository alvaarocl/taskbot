import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function database() {
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const wrap=(sql,params=[])=>({bind(...p){return wrap(sql,p)},async all(){return {results:db.prepare(sql).all(...params)}},async first(){return db.prepare(sql).get(...params)||null},async run(){const r=db.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}});
  return {prepare:wrap,async batch(statements){db.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}},raw:db};
}
export function kv() {
  const data=new Map();return {data,async get(key,options){const value=data.get(key);if(value===undefined)return null;return (options==='json'||options?.type==='json')?JSON.parse(value):value},async put(key,value){data.set(key,value)},async delete(key){data.delete(key)},async list({prefix=''}){return {keys:[...data.keys()].filter(x=>x.startsWith(prefix)).map(name=>({name})),list_complete:true}}};
}
export function environment(){return {DB:database(),FILES:kv(),TG_DRY_RUN:'1',OWNER_CHAT_ID:'42'};}
