// Conversiones de frontera: la agenda interna sigue en Europe/Madrid, proveedores en instantes UTC.
export function localParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date(ms)).map(x => [x.type,x.value]));
  return { date:`${p.year}-${p.month}-${p.day}`, time:`${p.hour}:${p.minute}` };
}
export function localEpoch(date, time = '00:00') {
  const target = Date.parse(`${date}T${time}:00Z`);
  let guess = target;
  for (let n=0;n<4;n++) {
    const p=localParts(guess); const delta=target-Date.parse(`${p.date}T${p.time}:00Z`);
    if (!delta) return guess;
    guess+=delta;
  }
  throw new Error('Hora local inexistente o ambigua; indica otra hora.');
}
export function splitInterval(start, end, label = 'Calendario externo') {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out=[]; let cursor=start;
  while(cursor<end && out.length<40) {
    const p=localParts(cursor); const nextDate=new Date(Date.parse(p.date+'T12:00Z')+86400000).toISOString().slice(0,10);
    const midnight=localEpoch(nextDate); const last=Math.min(end,midnight); const q=localParts(last);
    out.push({date:p.date,start:p.time,end:last===midnight?'24:00':q.time,label,fixed:true});
    cursor=last;
  }
  return out;
}
