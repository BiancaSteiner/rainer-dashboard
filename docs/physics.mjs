import {DIAMETER,SPEED,EventDetector,resolution} from "./lnm.mjs";

export const DIAMETER_MID=DIAMETER.slice(0,-1).map((d,i)=>(d+DIAMETER[i+1])/2);
export const SPEED_MID=SPEED.slice(0,-1).map((v,i)=>(v+SPEED[i+1])/2);
const RAIN=new Set(["Regen","Niesel","Regen und Niesel"]);
const ENERGY=Array.from({length:440},(_,i)=>{
  const diameter=DIAMETER_MID[Math.floor(i/20)];
  return diameter==null?null:1000*Math.PI/12*(diameter/1000)**3*SPEED_MID[i%20]**2;
});

export function areaFromAU(value){
  if(value==null||String(value).trim()==="")return null;
  const au=Number(value);
  if(!Number.isFinite(au)||au<850||au>1200)throw Error("AU-Werte müssen zwischen 850 und 1200 liegen.");
  return 4600*1000/au/1_000_000;
}
export function dropMetrics(record){
  const zero={valid:false,count:0,finiteCount:0,diameterSum:0,energy:0,open:0,sizes:Array(22).fill(0)};
  if(record.intensity==null)return zero;
  if(record.weather==="Trocken"&&record.intensity===0)return {...zero,valid:true};
  if(!RAIN.has(record.weather))return zero;
  const result={...zero,valid:true};
  for(let k=0;k<record.spectrum.length;k+=2){
    const index=record.spectrum[k],count=record.spectrum[k+1],diameter=Math.floor(index/20);
    result.count+=count;result.sizes[diameter]+=count;
    if(diameter===21){result.open+=count;continue;}
    result.finiteCount+=count;result.diameterSum+=DIAMETER_MID[diameter]*count;
    result.energy+=ENERGY[index]*count;
  }
  return result;
}

class DeviceSummary {
  constructor(device,start,end,step,area,dry){
    this.device=device;this.start=start;this.end=end;this.step=step;this.area=area;this.bins=new Map();
    this.q={telegrams:0,valid:0,count:0,finiteCount:0,diameterSum:0,energy:0,open:0,
      rain:0,peak:0,temperature_sum:0,temperature_n:0,excluded_minutes:0};
    this.spectrum=Array(440).fill(0);this.spectrum_minutes=0;this.events=new EventDetector(device,dry);
  }
  bin(ts){
    const t=Math.floor(ts/this.step)*this.step;
    if(!this.bins.has(t))this.bins.set(t,{ts:t,n:0,valid:0,count:0,finiteCount:0,diameterSum:0,energy:0,
      rain:0,peak:0,open:0,sizes:Array(22).fill(0),temperature_sum:0,temperature_n:0});
    return this.bins.get(t);
  }
  add(record,metrics,use){
    const q=this.q,b=this.bin(record.ts);q.telegrams++;b.n++;
    if(record.interior!=null){
      q.temperature_sum+=record.interior;q.temperature_n++;
      b.temperature_sum+=record.interior;b.temperature_n++;
    }
    if(!metrics.valid)q.excluded_minutes++;
    if(!use)return;
    q.valid++;b.valid++;
    for(const key of ["count","finiteCount","diameterSum","energy","open"]){q[key]+=metrics[key];b[key]+=metrics[key];}
    q.rain+=record.intensity/60;b.rain+=record.intensity/60;
    q.peak=Math.max(q.peak,record.intensity);b.peak=Math.max(b.peak,record.intensity);
    for(let i=0;i<22;i++)b.sizes[i]+=metrics.sizes[i];
    for(let i=0;i<record.spectrum.length;i+=2){
      // Trockenminuten tragen keine Tropfen zur Regenauswertung bei.
      if(record.weather!=="Trocken")this.spectrum[record.spectrum[i]]+=record.spectrum[i+1];
    }
    this.spectrum_minutes++;
  }
  finish(expected){
    const factor=this.area?1/this.area:1,q=this.q;let cumulative=0;
    const points=[...this.bins.values()].sort((a,b)=>a.ts-b.ts).map(b=>{
      cumulative+=b.energy*factor;
      return {ts:b.ts,n:b.n,valid:b.valid,count:b.valid?b.count*factor/b.valid:null,
        diameter:b.finiteCount?b.diameterSum/b.finiteCount:null,
        energy:b.valid?b.energy*factor/b.valid:null,cumulative:b.valid?cumulative:null,
        energy_sum:b.valid?b.energy*factor:null,open:b.open,
        intensity:b.valid?b.peak:null,interior:b.temperature_n?b.temperature_sum/b.temperature_n:null,
        sizes:b.sizes.map(n=>b.valid?n*factor/b.valid:null)};
    });
    const summary={...q,expected,coverage:expected?q.valid/expected*100:0,
      count:q.valid?q.count*factor:null,energy:q.valid?q.energy*factor:null,
      mean_diameter:q.finiteCount?q.diameterSum/q.finiteCount:null,
      interior:q.temperature_n?q.temperature_sum/q.temperature_n:null,rain:q.valid?q.rain:null};
    const matrix=this.spectrum.map(n=>this.spectrum_minutes?n*factor/this.spectrum_minutes:null);
    const sizes=Array.from({length:22},(_,i)=>this.spectrum_minutes?
      matrix.slice(i*20,i*20+20).reduce((a,b)=>a+b,0):null);
    return {device:this.device,summary,points,matrix,sizes,spectrum_minutes:this.spectrum_minutes,area_m2:this.area};
  }
}

export async function analyse(db,params,signal){
  const {selected,start,end}=await db.selection(params);
  const step=resolution(start,end,params.get("resolution")||"auto");
  const dry=Number(params.get("dry")||60);
  if(![30,60,120].includes(dry))throw Error("Ungültige Trockenpause");
  const normalized=params.get("unit")==="area";
  let au;
  try{au=JSON.parse(params.get("au")||"{}");}catch{throw Error("Ungültige AU-Werte");}
  const areas={};
  for(const device of selected){
    areas[device]=areaFromAU(au[device]);
    if(normalized&&!areas[device])throw Error("Für den Flächenvergleich bitte den AU-Wert aller ausgewählten Geräte eintragen.");
  }
  const common=params.get("common")!=="0",ready=await db.ready();
  const accumulators=selected.map(device=>new DeviceSummary(device,start,end,step,normalized?areas[device]:null,dry));
  const iterators=selected.map(device=>db.iterate(device,start,end,ready,signal));
  let heads=await Promise.all(iterators.map(it=>it.next()));
  const pairs=[];
  for(let i=0;i<selected.length;i++)for(let j=i+1;j<selected.length;j++)pairs.push({
    a:selected[i],b:selected[j],ai:i,bi:j,n:0,count_a:0,count_b:0,energy_a:0,energy_b:0,
    rain_a:0,rain_b:0,open_a:0,open_b:0,finite_a:0,finite_b:0,diameter_a:0,diameter_b:0,
    matrix_a:Array(440).fill(0),matrix_b:Array(440).fill(0),bins:new Map()
  });
  let commonMinutes=0;
  while(heads.some(h=>!h.done)){
    signal?.throwIfAborted();
    const t=Math.min(...heads.filter(h=>!h.done).map(h=>h.value.ts));
    const records=heads.map(h=>!h.done&&h.value.ts===t?h.value:null);
    const metrics=records.map(r=>r?dropMetrics(r):null);
    const shared=metrics.every(m=>m?.valid);
    if(shared)commonMinutes++;
    for(let i=0;i<records.length;i++){
      const r=records[i],m=metrics[i];if(!r)continue;
      const a=accumulators[i];
      a.add(r,m,m.valid&&(!common||shared));
      a.events.add({...r,intensity:m.valid?r.intensity:null,particles:m.count});
      if(m.valid&&r.intensity>0&&a.events.current){
        const event=a.events.current;
        event.energy=(event.energy||0)+m.energy;event.open=(event.open||0)+m.open;
      }
    }
    for(const p of pairs){
      const l=records[p.ai],r=records[p.bi],lm=metrics[p.ai],rm=metrics[p.bi];
      if(!lm?.valid||!rm?.valid)continue;
      const fa=normalized?1/areas[p.a]:1,fb=normalized?1/areas[p.b]:1;
      p.n++;p.count_a+=lm.count*fa;p.count_b+=rm.count*fb;p.energy_a+=lm.energy*fa;p.energy_b+=rm.energy*fb;
      p.rain_a+=l.intensity/60;p.rain_b+=r.intensity/60;p.open_a+=lm.open;p.open_b+=rm.open;
      p.finite_a+=lm.finiteCount;p.finite_b+=rm.finiteCount;p.diameter_a+=lm.diameterSum;p.diameter_b+=rm.diameterSum;
      const bin=Math.floor(t/step)*step;
      if(!p.bins.has(bin))p.bins.set(bin,{ts:bin,n:0,count:0,energy:0});
      const b=p.bins.get(bin);b.n++;b.count+=lm.count*fa-rm.count*fb;b.energy+=lm.energy*fa-rm.energy*fb;
      for(const [record,key,factor] of [[l,"matrix_a",fa],[r,"matrix_b",fb]]){
        if(record.weather==="Trocken")continue;
        for(let k=0;k<record.spectrum.length;k+=2)p[key][record.spectrum[k]]+=record.spectrum[k+1]*factor;
      }
    }
    heads=await Promise.all(heads.map((h,i)=>records[i]?iterators[i].next():h));
  }
  const expected=Math.floor((end-start)/60)+1;
  const series=accumulators.map(a=>a.finish(expected));
  const events=[];
  let eventsLimited=false;
  for(const a of accumulators){
    const result=a.events.finish();eventsLimited||=result.limited;
    for(const e of result.events){
      const factor=normalized?1/areas[a.device]:1;
      events.push({...e,particles:e.particles*factor,energy:(e.energy||0)*factor,open:e.open||0});
    }
  }
  events.sort((a,b)=>b.start-a.start);
  const comparisons=pairs.map(p=>{
    const difference=p.matrix_a.map((value,i)=>p.n?(value-p.matrix_b[i])/p.n:null);
    const sizes=Array.from({length:22},(_,i)=>p.n?difference.slice(i*20,i*20+20).reduce((a,b)=>a+b,0):null);
    return {a:p.a,b:p.b,n:p.n,count_a:p.n?p.count_a:null,count_b:p.n?p.count_b:null,
      energy_a:p.n?p.energy_a:null,energy_b:p.n?p.energy_b:null,
      energy_difference:p.n?p.energy_a-p.energy_b:null,
      rain_a:p.n?p.rain_a:null,rain_b:p.n?p.rain_b:null,
      mean_diameter_a:p.finite_a?p.diameter_a/p.finite_a:null,
      mean_diameter_b:p.finite_b?p.diameter_b/p.finite_b:null,open_a:p.open_a,open_b:p.open_b,
      matrix:difference,sizes,points:[...p.bins.values()].sort((a,b)=>a.ts-b.ts).map(b=>({
        ts:b.ts,n:b.n,count:b.count/b.n,energy:b.energy/b.n
      }))};
  });
  const scales={time_max:0,spectrum_max:0,difference_max:0};
  for(const s of series){
    for(const point of s.points)for(const value of point.sizes)scales.time_max=Math.max(scales.time_max,value||0);
    for(const value of s.matrix)scales.spectrum_max=Math.max(scales.spectrum_max,value||0);
  }
  for(const p of comparisons)for(const value of p.matrix)scales.difference_max=Math.max(scales.difference_max,Math.abs(value||0));
  return {start,end,step,series,pairs:comparisons,common,common_minutes:commonMinutes,normalized,
    diameter:DIAMETER,speed:SPEED,scales,events:events.slice(0,500),events_limited:eventsLimited||events.length>500};
}

function cell(value){
  const s=value==null?"":String(value);
  return /[;"\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
}
export async function exportAnalysis(db,params,send,signal){
  const {selected,start,end}=await db.selection(params),ready=await db.ready();
  let au;try{au=JSON.parse(params.get("au")||"{}");}catch{throw Error("Ungültige AU-Werte");}
  let text="\ufeff"+["device","logger_minute","rain_usable","rain_intensity_mmh","drop_count","mean_diameter_mm",
    "energy_finite_classes_J","energy_finite_classes_J_m2","area_m2","open_class_drops","interior_c",
    ...DIAMETER.map((_,i)=>"count_diameter_class_"+(i+1))].join(";")+"\r\n";
  for(const device of selected){
    const area=areaFromAU(au[device]);
    for await(const row of db.iterate(device,start,end,ready,signal)){
      const m=dropMetrics(row),valid=m.valid;
      text+=[device,new Date(row.ts*1000).toISOString().slice(0,16),Number(valid),valid?row.intensity:null,
        valid?m.count:null,m.finiteCount?m.diameterSum/m.finiteCount:null,valid?m.energy:null,
        valid&&area?m.energy/area:null,area,valid?m.open:null,row.interior,
        ...m.sizes.map(n=>valid?n:null)].map(cell).join(";")+"\r\n";
      if(text.length>256*1024){await send(text);text="";}
    }
  }
  if(text)await send(text);
  return {ok:true};
}
