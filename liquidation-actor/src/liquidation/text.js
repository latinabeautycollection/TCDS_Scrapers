export function cleanText(value) { return String(value ?? '').replace(/\s+/g,' ').trim(); }

export function parseMoneyCurrency(value) {
  const s = cleanText(value);
  if (!s) return { amount: null, currency: null };
  const upper = s.toUpperCase();
  let currency = null;
  if (/\bCAD\b|C\$/.test(upper)) currency = 'CAD';
  else if (/\bUSD\b|US\s*\$/.test(upper)) currency = 'USD';
  else if (/\bEUR\b|€/.test(s)) currency = 'EUR';
  else if (/\bGBP\b|£/.test(s)) currency = 'GBP';
  else if (/\bAUD\b|A\$/.test(upper)) currency = 'AUD';
  else if (/\bNZD\b|NZ\$/.test(upper)) currency = 'NZD';
  else if (/\$/.test(s)) currency = 'USD';
  const normalized = s.replace(/,/g, '');
  const patterns = [
    /(?:US\s*\$|C\$|A\$|NZ\$|\$|€|£)\s*(-?\d+(?:\.\d+)?)/i,
    /\b(?:USD|CAD|EUR|GBP|AUD|NZD)\s*\$?\s*(-?\d+(?:\.\d+)?)/i,
  ];
  let amount = null;
  for (const re of patterns) { const m = normalized.match(re); if (m) { amount = Number(m[1]); break; } }
  return { amount: Number.isFinite(amount) ? amount : null, currency };
}
export function money(value) { return parseMoneyCurrency(value).amount; }
export function integer(value) { const m=String(value??'').replace(/,/g,'').match(/\d+/); return m?Number.parseInt(m[0],10):null; }

const ET_FMT = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function easternOffsetIso(year,month,day,hour,minute=0,second=0){
  const guess=Date.UTC(year,month-1,day,hour,minute,second);
  for(const offset of [-4,-5]){
    const d=new Date(guess-offset*3600000);
    const parts=Object.fromEntries(ET_FMT.formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    if(Number(parts.year)===year&&Number(parts.month)===month&&Number(parts.day)===day&&Number(parts.hour)===hour&&Number(parts.minute)===minute) return d.toISOString();
  }
  return null;
}

export function parseLiquidationDate(value, observedAt = new Date().toISOString()) {
  const s = cleanText(value).replace(/^\(?CLOSES\s+/i,'').replace(/^CLOSED ON\s+/i,'').replace(/\)?$/,'');
  if(!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const exact=s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s*(ET|EST|EDT)?/i);
  if(exact){let [,mo,da,yr,hh,mi,ss='0',ap,tz='ET']=exact;let h=Number(hh)%12+(ap.toUpperCase()==='PM'?12:0);if(tz.toUpperCase()==='EST')return new Date(Date.UTC(+yr,+mo-1,+da,h+5,+mi,+ss)).toISOString();if(tz.toUpperCase()==='EDT')return new Date(Date.UTC(+yr,+mo-1,+da,h+4,+mi,+ss)).toISOString();return easternOffsetIso(+yr,+mo,+da,h,+mi,+ss);}
  const rel=s.match(/^(Today|Tomorrow)\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if(rel){const base=new Date(observedAt);const p=Object.fromEntries(ET_FMT.formatToParts(base).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));let y=+p.year,m=+p.month,d=+p.day;if(/^tomorrow$/i.test(rel[1])){const tmp=new Date(Date.UTC(y,m-1,d)+86400000);y=tmp.getUTCFullYear();m=tmp.getUTCMonth()+1;d=tmp.getUTCDate();}let h=Number(rel[2])%12+(rel[4].toUpperCase()==='PM'?12:0);return easternOffsetIso(y,m,d,h,+rel[3],0);}
  const md=s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if(md){const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};const mo=months[md[1].slice(0,3).toLowerCase()];if(!mo)return null;const obs=new Date(observedAt);const parts=Object.fromEntries(ET_FMT.formatToParts(obs).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));let y=+parts.year;let h=Number(md[3])%12+(md[5].toUpperCase()==='PM'?12:0);let iso=easternOffsetIso(y,mo,+md[2],h,+md[4],0);if(iso&&Date.parse(iso)<Date.parse(observedAt)-183*86400000) iso=easternOffsetIso(y+1,mo,+md[2],h,+md[4],0);return iso;}
  return null;
}

export function inferAuctionStatus(text,endIso,now=new Date()) {
  const t=cleanText(text);
  if(/CLOSED ON|WINNING BID|auction\s+closed/i.test(t)) return 'ENDED';
  if(/cancelled|canceled/i.test(t)) return 'CANCELLED';
  if(endIso && Date.parse(endIso)<=now.getTime()) return 'ENDED';
  if(endIso) return 'ACTIVE';
  return 'UNKNOWN';
}
export function timeRemainingSeconds(endIso, observedIso){const e=Date.parse(endIso||''),o=Date.parse(observedIso||'');return Number.isFinite(e)&&Number.isFinite(o)?Math.max(0,Math.floor((e-o)/1000)):null;}