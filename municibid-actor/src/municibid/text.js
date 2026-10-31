export function cleanText(value) { return String(value ?? '').replace(/\s+/g,' ').trim(); }
export function money(value) {
  if (value == null) return null;
  const m=String(value).replace(/,/g,'').match(/\$\s*(-?\d+(?:\.\d{1,2})?)/) || String(value).replace(/,/g,'').match(/(?:USD\s*)?(-?\d+(?:\.\d{1,2})?)/i);
  if (!m) return null; const n=Number.parseFloat(m[1]); return Number.isFinite(n)&&n>=0?Math.round(n*100)/100:null;
}
export function integer(value) { const m=String(value??'').match(/\d+/); return m?Number.parseInt(m[0],10):null; }
const TZ_OFFSETS={ET:null,EST:'-05:00',EDT:'-04:00',CT:null,CST:'-06:00',CDT:'-05:00',MT:null,MST:'-07:00',MDT:'-06:00',PT:null,PST:'-08:00',PDT:'-07:00',UTC:'+00:00',GMT:'+00:00'};
const GENERIC_ZONES={ET:'America/New_York',CT:'America/Chicago',MT:'America/Denver',PT:'America/Los_Angeles'};
function zoneOffsetForLocal(year,month,day,hour,minute,second,timeZone){
  const probe=Date.UTC(year,month,day,hour,minute,second);
  const fmt=new Intl.DateTimeFormat('en-US',{timeZone,hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const parts=Object.fromEntries(fmt.formatToParts(new Date(probe)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  const represented=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
  const offsetMinutes=Math.round((represented-probe)/60000);
  const sign=offsetMinutes>=0?'+':'-'; const abs=Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs/60)).padStart(2,'0')}:${String(abs%60).padStart(2,'0')}`;
}
function nthWeekdayOfMonth(year,month,weekday,n){ const d=new Date(Date.UTC(year,month,1)); const delta=(weekday-d.getUTCDay()+7)%7; return 1+delta+(n-1)*7; }
function easternOffset(year,month,day,hour=12){
  // US DST: second Sunday in March 02:00 through first Sunday in November 02:00.
  const start=nthWeekdayOfMonth(year,2,0,2), end=nthWeekdayOfMonth(year,10,0,1);
  const afterStart=month>2 || (month===2 && (day>start || (day===start && hour>=2)));
  const beforeEnd=month<10 || (month===10 && (day<end || (day===end && hour<2)));
  return afterStart && beforeEnd ? '-04:00' : '-05:00';
}
export function parseMunicibidDate(value){
  const t=cleanText(value); if(!t) return null;
  let candidate=t.replace(/^(?:Start Date|End Date|This auction ends in)\s*/i,'').trim();
  candidate=candidate.replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i,'');
  const parts=candidate.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s*(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UTC|GMT)?/i)
    || candidate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s*(ET|EST|EDT)?/i);
  if(!parts){ const d=new Date(candidate); return Number.isNaN(d.getTime())?null:d.toISOString(); }
  let year,month,day,hour,minute,second,ampm,tz;
  if (/^[A-Za-z]/.test(parts[1])) {
    const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']; month=months.indexOf(parts[1].slice(0,3).toLowerCase()); day=+parts[2]; year=+parts[3]; hour=+parts[4]; minute=+parts[5]; second=+(parts[6]||0); ampm=parts[7]; tz=(parts[8]||'ET').toUpperCase();
  } else { month=+parts[1]-1; day=+parts[2]; year=+parts[3]; hour=+parts[4]; minute=+parts[5]; second=+(parts[6]||0); ampm=parts[7]; tz=(parts[8]||'ET').toUpperCase(); }
  if (/PM/i.test(ampm) && hour<12) hour+=12; if(/AM/i.test(ampm)&&hour===12)hour=0;
  let off=TZ_OFFSETS[tz];
  if(GENERIC_ZONES[tz]) off=zoneOffsetForLocal(year,month,day,hour,minute,second,GENERIC_ZONES[tz]);
  if(!tz) off=easternOffset(year,month,day,hour);
  const isoLocal=`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}${off}`;
  const d=new Date(isoLocal); return Number.isNaN(d.getTime())?null:d.toISOString();
}
export function inferAuctionStatus(text,endIso,now=new Date()){
  const t=cleanText(text).toLowerCase();
  if(/cancelled|canceled|withdrawn/.test(t))return 'CANCELLED';
  if(/auction closed|auction ended|completed listing|sold for/.test(t))return 'ENDED';
  if(/auction has not started|upcoming/.test(t))return 'UPCOMING';
  if(endIso){const x=Date.parse(endIso);if(Number.isFinite(x))return x<=now.getTime()?'ENDED':'ACTIVE';}
  return 'UNKNOWN';
}
export function timeRemainingSeconds(endIso,observedIso){const e=Date.parse(endIso||''),o=Date.parse(observedIso||'');return Number.isFinite(e)&&Number.isFinite(o)?Math.max(0,Math.floor((e-o)/1000)):null;}