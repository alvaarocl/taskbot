export async function runSync(env,source,fn) {
  const attempted=new Date().toISOString();
  try {
    const value=await fn();
    await env.DB.prepare(`INSERT INTO sync_state (source,success_at,attempted_at,error) VALUES (?,?,?,NULL)
      ON CONFLICT(source) DO UPDATE SET success_at=excluded.success_at,attempted_at=excluded.attempted_at,error=NULL`).bind(source,new Date().toISOString(),attempted).run();
    return value;
  } catch(e) {
    await env.DB.prepare(`INSERT INTO sync_state (source,attempted_at,error) VALUES (?,?,?)
      ON CONFLICT(source) DO UPDATE SET attempted_at=excluded.attempted_at,error=excluded.error`).bind(source,attempted,String(e.message||e).slice(0,300)).run();
    console.error('sync',source,e?.name||'error');
  }
}
export async function syncStatus(env) {
  const {results}=await env.DB.prepare('SELECT * FROM sync_state ORDER BY source').all();
  return results;
}
