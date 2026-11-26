export const DIAMETER=[.125,.25,.375,.5,.75,1,1.25,1.5,1.75,2,2.5,3,3.5,4,4.5,5,5.5,6,6.5,7,7.5,8];
export const SPEED=[0,.2,.4,.6,.8,1,1.4,1.8,2.2,2.6,3,3.4,4.2,5,5.8,6.6,7.4,8.2,9,10,20];
export const FLAGS=("laser_off static_signal laser_temp_analog laser_temp_digital laser_current_analog "+
  "laser_current_digital sensor_supply heater_laser heater_receiver temperature_sensor heater_supply "+
  "heater_housing heater_heads heater_carriers laser_control").split(" ");
export const NUMERIC=["intensity","particles","quality","interior","laser_temp","supply","control",
  "heater_laser","heater_receiver","ambient","warnings"];
const WEATHER={NP:"Trocken",DZ:"Niesel",RADZ:"Regen und Niesel",RA:"Regen",RASN:"Schneeregen",
  SN:"Schnee",SG:"Schneegriesel",GS:"Graupel/Eiskörner",GR:"Hagel",UP:"Unbestimmt","?????":"Sensorfehler"};
const MARKERS=new Set(["\x03","_x0003_",String.raw`\u0003`]);
const FIELDS={intensity:[12,999.999],particles:[49,99999],quality:[18,999],interior:[36,999],
  laser_temp:[37,99],supply:[41,999,.1],control:[39,9999],heater_laser:[42,999],
  heater_receiver:[43,999],ambient:[44,999.9]};
export const defaults=()=>[
  {key:"wald1",name:"Wald 1",id:"01"},{key:"wald2",name:"Wald 2",id:"02"},
  {key:"lichtung",name:"Lichtung",id:"03"}
];

export function timestamp(value){
  const text=String(value).trim();
  let parts=text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  let year,month,day,hour,minute,second;
  if(parts){
    [,day,month,year,hour,minute,second]=parts.map((p,i)=>i?Number(p||0):p);
    if(year<100)year+=year>=69?1900:2000;
  }else{
    parts=text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
    if(!parts)throw Error("Zeitstempel nicht lesbar: "+text);
    [,year,month,day,hour,minute,second]=parts.map((p,i)=>i?Number(p||0):p);
  }
  const date=new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if(year<1900||year>2199||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||
     date.getUTCDate()!==day||hour>23||minute>59||second>59)throw Error("Ungültiger Zeitstempel: "+text);
  return Math.floor(date.getTime()/60000)*60;
}
function number(text,sentinel){
  const value=String(text??"").trim();
  if(!value)return null;
  if(!/^[+-]?\d+(?:[.,]\d+)?$/.test(value))throw Error("Nichtnumerischer Messwert");
  const n=Number(value.replace(",","."));
  if(!Number.isFinite(n))throw Error("Nicht endlicher Messwert");
  return Math.abs(n)===sentinel||(sentinel===999.9&&(value==="99999"||value==="999999"))?null:n;
}
export function isMarker(fields){
  return fields.length&&MARKERS.has(fields[0].trim())&&fields.slice(1).every(f=>!f.trim());
}
export function parseTelegram(cells,raw=""){
  const fields=cells.slice(2);
  while(fields.length&&(!fields.at(-1).trim()||MARKERS.has(fields.at(-1).trim())))fields.pop();
  if(fields.length!==520&&fields.length!==524){
    if(fields.length===1&&/Fehler|Keine Antwort|!\d{2}TR00001/.test(fields[0]))throw Error(fields[0]);
    throw Error("Feldanzahl "+fields.length+" (erwartet 520 oder 524)");
  }
  const observed=cells[1].trim().padStart(2,"0");
  const native=fields[0].replace(/^(_x0002_|\\u0002|\x02)/,"").trim().padStart(2,"0");
  if(native!==observed)throw Error("Telegramm-ID stimmt nicht zur Logger-ID");
  const check=fields.at(-1).trim().toUpperCase();
  if(!/^[0-9A-F]{2}$/.test(check))throw Error("Ungültiges Prüfsummenfeld");
  let checksum="nicht_pruefbar";
  const framed=raw.match(/\x02[\s\S]*;([0-9A-Fa-f]{2});\r\n\x03/);
  if(framed&&(raw.match(/\x02/g)||[]).length===1){
    const frame=framed[0],position=frame.length-6;
    const payload=frame.slice(0,position)+frame.slice(position+2);
    if([...payload].some(c=>c.charCodeAt(0)>127))throw Error("Nicht-ASCII-Zeichen im Telegramm");
    const sum=[...payload].reduce((a,c)=>a+c.charCodeAt(0),0);
    if((256-sum%256)%256!==parseInt(check,16))throw Error("Prüfsumme stimmt nicht");
    checksum="ok";
  }
  const record={ts:timestamp(cells[0]),logger_time:cells[0],sensor_time:fields[3]+" "+fields[4],
    serial:fields[1],metar:fields[11].trim(),checksum};
  record.weather=WEATHER[record.metar.replace(/^[+-]/,"")]||"METAR "+record.metar;
  for(const [key,[index,sentinel,scale=1]] of Object.entries(FIELDS)){
    record[key]=number(fields[index],sentinel);
    if(record[key]!=null)record[key]*=scale;
  }
  if(fields[12].trim()==="999999")record.intensity=null;
  if(record.ambient==null&&fields.length===524)record.ambient=number(fields[519],999.9);
  if(record.quality!=null&&(record.quality<0||record.quality>100))throw Error("Qualität außerhalb 0–100");
  if(record.intensity!=null&&record.intensity<0||record.particles!=null&&record.particles<0)throw Error("Negativer Niederschlags- oder Partikelwert");
  record.flags={};record.warnings=0;
  for(let i=0;i<FLAGS.length;i++){
    if(!/^[019]$/.test(fields[20+i].trim()))throw Error("Ungültiges Statusflag");
    const value=Number(fields[20+i]);record.flags[FLAGS[i]]=value===9?null:value;
    if(value===1)record.warnings=1;
  }
  const sparse=[];
  for(let i=0;i<440;i++){
    const text=fields[79+i].trim();
    if(!/^\d{1,4}$/.test(text))throw Error("Ungültige Spektralklasse");
    const n=Number(text);if(n)sparse.push(i,n);
  }
  record.spectrum=new Uint16Array(sparse);
  if(record.weather==="Sensorfehler"||record.weather==="Unbestimmt")record.intensity=null;
  return record;
}
export function sameRecord(a,b){
  return NUMERIC.every(k=>a[k]===b[k])&&a.weather===b.weather&&a.serial===b.serial&&
    FLAGS.every(k=>a.flags[k]===b.flags[k])&&a.spectrum.length===b.spectrum.length&&
    a.spectrum.every((n,i)=>n===b.spectrum[i]);
}

export function parseCsv(text,delimiter){
  const rows=[];let fields=[],field="",quoted=false,afterQuote=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"') {if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;afterQuote=true;}}
      else field+=c;
    }else if(c===delimiter){fields.push(field);field="";afterQuote=false;}
    else if(c==="\r"||c==="\n"){
      if(c==="\r"&&text[i+1]==="\n")i++;
      fields.push(field);rows.push(fields);fields=[];field="";afterQuote=false;
    }else if(c==='"'&&field===""){quoted=true;afterQuote=false;}
    else if(afterQuote&&c.trim())throw Error("Ungültige CSV-Anführungszeichen");
    else if(!afterQuote)field+=c;
  }
  if(quoted)throw Error("Unvollständige CSV-Anführungszeichen");
  if(field||fields.length){fields.push(field);rows.push(fields);}
  return rows;
}
export async function detectSeparator(file,encoding="utf-8"){
  const sample=new TextDecoder(encoding).decode(await file.slice(0,256*1024).arrayBuffer());
  let best=";",bestScore=0;
  for(const separator of [";","\t",","]){
    let score=0;
    for(const line of sample.split(/\r?\n/).slice(0,80)){
      try{
        const row=parseCsv(line,separator)[0];
        if(row&&/^\d{1,2}$/.test((row[1]||"").trim()))score++;
      }catch{}
    }
    if(score>bestScore){bestScore=score;best=separator;}
  }
  if(!bestScore)throw Error("Keine Logger-ID in Spalte 2 erkannt. Erwartet werden Loggerzeit, ID und Telegrammfelder.");
  return best;
}
export async function* csvRows(file,encoding="utf-8"){
  const delimiter=await detectSeparator(file,encoding),decoder=new TextDecoder(encoding);
  let text="",raw="",quotes=0,line=1,recordLine=1,bytes=0,pending=null,pendingCR=false;
  function* finishLine(){
    if(quotes%2!==0)return;
    const row={cells:parseCsv(raw,delimiter)[0]||[],raw,line:recordLine,bytes};
    raw="";quotes=0;recordLine=line;
    if(isMarker(row.cells)){
      if(pending){pending.raw+=row.raw;yield pending;pending=null;}
    }else{
      if(pending)yield pending;
      pending=row;
    }
  }
  async function* records(chunk){
    for(const c of chunk){
      if(pendingCR&&c!=="\n"){line++;yield* finishLine();}
      pendingCR=false;
      raw+=c;
      if(c==='"')quotes++;
      if(raw.length>10_000_000)throw Error("CSV-Zeile überschreitet 10 MB. Bitte das Dateiformat prüfen.");
      if(c==="\r"){pendingCR=true;continue;}
      if(c==="\n"){
        line++;
        yield* finishLine();
      }
    }
  }
  for await(const chunk of file.stream()){
    bytes+=chunk.byteLength;text=decoder.decode(chunk,{stream:true});
    yield* records(text);
  }
  yield* records(decoder.decode());
  if(pendingCR){line++;yield* finishLine();}
  if(raw.trim()){
    if(quotes%2)throw Error("Unvollständige CSV-Zeile am Dateiende");
    const row={cells:parseCsv(raw,delimiter)[0]||[],raw,line:recordLine,bytes};
    if(isMarker(row.cells)){if(pending)pending.raw+=raw;}
    else{if(pending)yield pending;pending=row;}
  }
  if(pending)yield pending;
}

export function resolution(start,end,requested="auto"){
  if(requested!=="auto"){
    const step=Number(requested)*60;
    if(![60,300,900,3600,86400].includes(step))throw Error("Ungültige Auflösung");
    if((end-start)/step>5000)throw Error("Bitte einen kürzeren Zeitraum oder eine gröbere Auflösung wählen.");
    return step;
  }
  return [60,300,900,3600,10800,43200,86400].find(n=>(end-start)/n<=1400)||86400;
}

export class Overview {
  constructor(start,end,step){
    this.start=start;this.end=end;this.step=step;this.bins=new Map();this.weather=new Map();this.flags={};
    this.summary={telegrams:0,valid:0,rain:null,peak:null,particles:null,quality:null,low80:0,low90:0,warnings:0,control_bad:0};
    this.qualitySum=0;this.qualityN=0;
  }
  add(r){
    const q=this.summary;q.telegrams++;
    if(r.intensity!=null){q.valid++;q.rain=(q.rain||0)+r.intensity/60;q.peak=Math.max(q.peak??0,r.intensity);}
    if(r.particles!=null)q.particles=(q.particles||0)+r.particles;
    if(r.quality!=null){this.qualitySum+=r.quality;this.qualityN++;q.low80+=r.quality<80;q.low90+=r.quality<90;}
    q.warnings+=r.warnings;q.control_bad+=r.control!=null&&Math.abs(r.control-4010)>5;
    for(const [key,value] of Object.entries(r.flags))if(value===1)this.flags[key]=(this.flags[key]||0)+1;
    const t=Math.floor(r.ts/this.step)*this.step;
    if(!this.bins.has(t))this.bins.set(t,{n:0,stats:{}});
    const bin=this.bins.get(t);
    bin.n++;
    for(const key of NUMERIC){
      const value=r[key];
      if(value==null)continue;
      const s=bin.stats[key]||(bin.stats[key]={n:0,sum:0,min:value,max:value});
      s.n++;s.sum+=value;s.min=Math.min(s.min,value);s.max=Math.max(s.max,value);
    }
    const key=t+"|"+r.weather;
    if(!this.weather.has(key))this.weather.set(key,{ts:t,weather:r.weather,n:0});
    this.weather.get(key).n++;
  }
  finish(device,attempts){
    let cumulative=0;
    const points=[...this.bins].sort((a,b)=>a[0]-b[0]).map(([ts,bin])=>{
      const stats=bin.stats,valid=stats.intensity?.n||0,rain=valid?stats.intensity.sum/60:null;
      cumulative+=rain||0;
      const average=key=>stats[key]?stats[key].sum/stats[key].n:null;
      const p={ts,n:bin.n,valid,intensity:stats.intensity?.max??null,
        intensity_mean:average("intensity"),rain,cumulative:valid?cumulative:null,
        particles:stats.particles?.sum??null,quality:stats.quality?.min??null,
        quality_mean:average("quality"),warnings:stats.warnings?.sum??null};
      for(const key of ["interior","laser_temp","ambient","supply","control","heater_laser","heater_receiver"])p[key]=average(key);
      for(const key of ["supply","control"]){p[key+"_min"]=stats[key]?.min??null;p[key+"_max"]=stats[key]?.max??null;}
      return p;
    });
    const q=this.summary,expected=Math.floor((this.end-this.start)/60)+1;
    Object.assign(q,{expected,missing:Math.max(0,expected-q.telegrams),missing_logger:Math.max(0,expected-attempts),
      invalid:q.telegrams-q.valid,coverage:expected?q.valid/expected*100:0,quality:this.qualityN?this.qualitySum/this.qualityN:null});
    return {device,summary:q,points,weather:[...this.weather.values()].sort((a,b)=>a.ts-b.ts||b.n-a.n),flags:this.flags};
  }
}

export class EventDetector {
  constructor(device,dry=60,limit=500){this.device=device;this.dry=dry;this.limit=limit;this.current=null;this.previous=null;this.events=[];this.limited=false;}
  close(){
    if(this.current){if(this.events.length<this.limit)this.events.push(this.current);else this.limited=true;}
    this.current=null;
  }
  add(r){
    const t=r.ts,i=r.intensity;
    if(this.current&&(t-this.previous>60||i==null||t-this.current.end>this.dry*60))this.close();
    if(i!=null&&i>0){
      if(!this.current)this.current={device:this.device,start:t,end:t,rain:0,peak:0,wet:0,particles:0,quality_min:null};
      const e=this.current;e.end=t;e.rain+=i/60;e.peak=Math.max(e.peak,i);e.wet++;e.particles+=r.particles||0;
      if(r.quality!=null)e.quality_min=Math.min(e.quality_min??100,r.quality);
    }
    this.previous=t;
  }
  finish(){this.close();return {events:this.events,limited:this.limited};}
}
