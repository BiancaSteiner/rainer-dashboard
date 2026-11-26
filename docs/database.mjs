import {defaults,csvRows,parseTelegram,timestamp,sameRecord,resolution,Overview,EventDetector,
  DIAMETER,SPEED,NUMERIC} from "./lnm.mjs";

const requestResult=request=>new Promise((resolve,reject)=>{
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});
const completed=transaction=>new Promise((resolve,reject)=>{
  transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error||Error("Speichertransaktion abgebrochen"));
  transaction.onerror=()=>{};
});
const identifier=()=>crypto.randomUUID();
function csvCell(value){
  const text=value==null?"":String(value);
  return /[;"\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;
}

export class BrowserData {
  constructor(scope,mode="own"){
    this.name="rainer-v1-"+scope+"-"+mode;this.mode=mode;this.running=false;this.message="Bereit";
    this.results=[];this.db=null;
  }
  async open(){
    if(this.db)return this;
    const request=indexedDB.open(this.name,1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      db.createObjectStore("devices",{keyPath:"key"});
      db.createObjectStore("imports",{keyPath:"id"});
      for(const name of ["samples","attempts"]){
        const store=db.createObjectStore(name,{keyPath:["source","ts"]});
        store.createIndex("byDevice",["device","ts","source"]);
        store.createIndex("bySource","source");
      }
    };
    this.db=await requestResult(request);
    this.db.onversionchange=()=>{this.db.close();this.db=null;};
    const tx=this.db.transaction("devices","readwrite"),done=completed(tx),store=tx.objectStore("devices");
    for(const d of defaults()){
      const found=store.get(d.key);
      found.onsuccess=()=>{if(!found.result)store.put({...d,first:null,last:null,minutes:0});};
    }
    await done;return this;
  }
  async all(name){
    const tx=this.db.transaction(name),done=completed(tx);
    const values=await requestResult(tx.objectStore(name).getAll());await done;return values;
  }
  async ready(){
    return new Set((await this.all("imports")).filter(i=>i.status==="done").map(i=>i.id));
  }
  async scan(name,device,start,end,ready,callback,signal){
    let lower=[device,start],exclusive=false,lastTime=null;
    const upper=[device,end,"\uffff"];
    while(true){
      signal?.throwIfAborted();
      const tx=this.db.transaction(name),done=completed(tx);
      const rows=await requestResult(tx.objectStore(name).index("byDevice").getAll(
        IDBKeyRange.bound(lower,upper,exclusive,false),1000));
      await done;
      if(!rows.length)return;
      for(const r of rows){
        if(!ready.has(r.source))continue;
        if(name==="attempts"&&r.ts===lastTime)continue;
        callback(r);lastTime=r.ts;
      }
      const last=rows.at(-1);lower=[last.device,last.ts,last.source];exclusive=true;
    }
  }
  async meta(){
    const devices=await this.all("devices");
    return {devices,demo:this.mode==="demo",browser:true,online:false,token:"local",
      configured:devices.map(d=>({...d,csv:"Im Browser gespeichert"})),config_error:null,
      import_state:{running:this.running,message:this.message,results:this.results}};
  }
  async history(){
    return (await this.all("imports")).sort((a,b)=>b.created-a.created).slice(0,100).map(i=>({
      ...i,device:i.device,filename:i.filename,imported_at:new Date(i.created).toISOString().slice(0,19),
      accepted:i.status==="done"?i.accepted:0,examples:i.examples||[],
      status:i.status==="importing"?"Unterbrochen":i.status==="done"?"Abgeschlossen":"Fehler"
    }));
  }
  async cleanStaging(){
    for(const record of await this.all("imports")){
      if(record.status==="done"||record.cleaned)continue;
      for(const name of ["samples","attempts"]){
        const tx=this.db.transaction(name,"readwrite"),done=completed(tx),store=tx.objectStore(name);
        const cursor=store.index("bySource").openKeyCursor(IDBKeyRange.only(record.id));
        cursor.onsuccess=()=>{
          const item=cursor.result;
          if(item){store.delete(item.primaryKey);item.continue();}
        };
        await done;
      }
      const tx=this.db.transaction("imports","readwrite"),done=completed(tx);
      tx.objectStore("imports").put({...record,status:"error",accepted:0,cleaned:true});
      await done;
    }
  }
  async writeBatch(records,attempts,info,ready){
    const tx=this.db.transaction(["samples","attempts"],"readwrite"),done=completed(tx);
    const samples=tx.objectStore("samples"),index=samples.index("byDevice");
    const local=new Map();
    for(const r of records){
      if(!local.has(r.ts))local.set(r.ts,[]);
      local.get(r.ts).push(r);
    }
    for(const group of local.values()){
      const r=group[0];
      const previous=index.getAll(IDBKeyRange.bound([r.device,r.ts],[r.device,r.ts,"\uffff"]));
      previous.onsuccess=()=>{
        const found=previous.result.find(p=>ready.has(p.source)||p.source===info.id);
        const authoritative=found||r;
        if(!found){samples.put(r);info.accepted++;}
        for(const candidate of found?group:group.slice(1))info[sameRecord(authoritative,candidate)?"duplicates":"conflicts"]++;
      };
    }
    for(const t of attempts)tx.objectStore("attempts").put({source:info.id,device:info.device,ts:t});
    await done;
  }
  async importFile(file,options,progress){
    const {device,id,encoding="utf-8"}=options;
    if(!(await this.all("devices")).some(d=>d.key===device))throw Error("Unbekannter Standort");
    if(!/^\d{1,2}$/.test(id))throw Error("Bitte eine ein- oder zweistellige Logger-ID eingeben.");
    const ready=await this.ready();
    const info={id:identifier(),device,filename:file.name,created:Date.now(),status:"importing",
      rows:0,accepted:0,errors:0,duplicates:0,conflicts:0,bad_bytes:0,checksum_unchecked:0,examples:[]};
    let records=[],attempts=[],first=null,last=null;
    {
      const tx=this.db.transaction("imports","readwrite"),done=completed(tx);
      tx.objectStore("imports").put(info);await done;
    }
    try{
      for await(const row of csvRows(file,encoding)){
        const cells=row.cells;
        if(cells.length<2||!/^\d{1,2}$/.test(cells[1].trim())||Number(cells[1])!==Number(id))continue;
        info.rows++;
        info.bad_bytes+=(row.raw.match(/\ufffd/g)||[]).length;
        try{
          const t=timestamp(cells[0]);attempts.push(t);first=first==null?t:Math.min(first,t);last=last==null?t:Math.max(last,t);
          const parsed=parseTelegram(cells,row.raw);
          parsed.device=device;parsed.source=info.id;parsed.row=row.line;records.push(parsed);
          if(parsed.checksum!=="ok")info.checksum_unchecked++;
        }catch(error){
          info.errors++;if(info.examples.length<12)info.examples.push({line:row.line,error:error.message});
        }
        if(info.rows%500===0){
          await this.writeBatch(records,attempts,info,ready);records=[];attempts=[];
          progress({message:file.name+" · "+info.rows.toLocaleString("de-DE")+" Zeilen geprüft",
            percent:Math.min(99,Math.round(row.bytes/file.size*100)),...info});
        }
      }
      await this.writeBatch(records,attempts,info,ready);
      if(!info.rows)throw Error("Keine Zeile mit Logger-ID "+id+" gefunden. Bitte ID und Dateiformat prüfen.");
      const tx=this.db.transaction(["devices","imports"],"readwrite"),done=completed(tx);
      const devices=tx.objectStore("devices"),get=devices.get(device);
      get.onsuccess=()=>{
        const d=get.result;
        if(first!=null){d.first=d.first==null?first:Math.min(d.first,first);d.last=d.last==null?last:Math.max(d.last,last);}
        d.minutes+=info.accepted;d.id=id.padStart(2,"0");devices.put(d);
        tx.objectStore("imports").put({...info,status:"done"});
      };
      await done;
      return {device,file:file.name,status:"Eingelesen",...info,statusCode:"done"};
    }catch(error){
      try{
        const tx=this.db.transaction("imports","readwrite"),done=completed(tx);
        tx.objectStore("imports").put({...info,status:"error",accepted:0,examples:[...info.examples,{error:error.message,line:0}]});
        await done;
      }catch{}
      throw error;
    }
  }
  async importFiles(files,options,progress){
    if(this.mode!=="own")throw Error("Für eigene CSVs bitte auf eigene Messdaten wechseln.");
    if(this.running)throw Error("Ein Import läuft bereits.");
    if(!navigator.locks)throw Error("Bitte eine aktuelle Version von Chrome, Edge, Firefox oder Safari verwenden.");
    this.running=true;this.results=[];this.message="Import startet";
    try{
      return await navigator.locks.request(this.name+"-write",async()=>{
        await this.cleanStaging();
        for(const file of files){
          try{
            const result=await this.importFile(file,options,event=>{
              this.message=event.message;progress(event);
            });
            this.results.push({...result,status:"Eingelesen"});
          }catch(error){
            this.results.push({device:options.device,file:file.name,status:"Fehler",error:error.name==="QuotaExceededError"?
              "Der Browserspeicher ist voll. Bitte Speicher freigeben oder einen kleineren Zeitraum importieren.":error.message});
          }
        }
        this.message="Import abgeschlossen";return this.results;
      });
    }finally{this.running=false;}
  }
  async selection(params){
    const devices=await this.all("devices"),keys=new Set(devices.map(d=>d.key));
    const selected=(params.get("devices")||devices.map(d=>d.key).join(",")).split(",");
    if(!selected.length||selected.some(d=>!keys.has(d)))throw Error("Bitte ein verfügbares Gerät auswählen.");
    const ranges=devices.filter(d=>selected.includes(d.key)&&d.first!=null);
    const first=ranges.length?Math.min(...ranges.map(d=>d.first)):0,last=ranges.length?Math.max(...ranges.map(d=>d.last)):0;
    const start=Number(params.get("start")??Math.max(first,last-86340)),end=Number(params.get("end")??last);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw Error("Ungültiger Zeitraum.");
    return {selected,start:Math.floor(start/60)*60,end:Math.floor(end/60)*60};
  }
  async overview(params,signal){
    const {selected,start,end}=await this.selection(params),step=resolution(start,end,params.get("resolution")||"auto");
    const ready=await this.ready(),series=[];
    for(const device of selected){
      const aggregate=new Overview(start,end,step);let attempts=0;
      await this.scan("samples",device,start,end,ready,r=>aggregate.add(r),signal);
      await this.scan("attempts",device,start,end,ready,()=>attempts++,signal);
      series.push(aggregate.finish(device,attempts));
    }
    return {start,end,step,series};
  }
  async spectrum(params,signal){
    const {selected,start,end}=await this.selection(params),ready=await this.ready(),series=[];
    for(const device of selected){
      const matrix=Array(440).fill(0);let minutes=0;
      await this.scan("samples",device,start,end,ready,r=>{
        minutes++;for(let i=0;i<r.spectrum.length;i+=2)matrix[r.spectrum[i]]+=r.spectrum[i+1];
      },signal);
      const sizes=Array.from({length:22},(_,i)=>matrix.slice(i*20,i*20+20).reduce((a,b)=>a+b,0));
      series.push({device,minutes,matrix,sizes});
    }
    return {series,diameter:DIAMETER,speed:SPEED};
  }
  async events(params,signal){
    const {selected,start,end}=await this.selection(params),dry=Number(params.get("dry")||60),ready=await this.ready();
    if(![30,60,120].includes(dry))throw Error("Ungültige Trockenpause");
    let events=[],limited=false;
    for(const device of selected){
      const detector=new EventDetector(device,dry);
      await this.scan("samples",device,start,end,ready,r=>detector.add(r),signal);
      const result=detector.finish();events.push(...result.events);limited||=result.limited;
    }
    events.sort((a,b)=>b.start-a.start);
    return {events:events.slice(0,500),limited:limited||events.length>500};
  }
  async *iterate(device,start,end,ready,signal){
    let lower=[device,start],exclusive=false;
    while(true){
      signal?.throwIfAborted();
      const tx=this.db.transaction("samples"),done=completed(tx);
      const rows=await requestResult(tx.objectStore("samples").index("byDevice").getAll(
        IDBKeyRange.bound(lower,[device,end,"\uffff"],exclusive,false),1000));
      await done;
      if(!rows.length)return;
      for(const row of rows)if(ready.has(row.source))yield row;
      const last=rows.at(-1);lower=[device,last.ts,last.source];exclusive=true;
    }
  }
  async comparison(params,signal){
    const {selected,start,end}=await this.selection(params),ready=await this.ready(),pairs=[];
    for(let ai=0;ai<selected.length;ai++)for(let bi=ai+1;bi<selected.length;bi++){
      const a=selected[ai],b=selected[bi],left=this.iterate(a,start,end,ready,signal),right=this.iterate(b,start,end,ready,signal);
      let x=await left.next(),y=await right.next();
      const p={a,b,n:0,rain_a:null,rain_b:null,peak_a:null,peak_b:null,particles_a:null,particles_b:null};
      let mx=0,my=0,mxx=0,myy=0,mxy=0;
      while(!x.done&&!y.done){
        if(x.value.ts<y.value.ts){x=await left.next();continue;}
        if(y.value.ts<x.value.ts){y=await right.next();continue;}
        const l=x.value,r=y.value;
        if(l.intensity!=null&&r.intensity!=null){
          p.n++;p.rain_a=(p.rain_a||0)+l.intensity/60;p.rain_b=(p.rain_b||0)+r.intensity/60;
          p.peak_a=Math.max(p.peak_a??0,l.intensity);p.peak_b=Math.max(p.peak_b??0,r.intensity);
          if(l.particles!=null)p.particles_a=(p.particles_a||0)+l.particles;
          if(r.particles!=null)p.particles_b=(p.particles_b||0)+r.particles;
          const dx=l.intensity-mx,dy=r.intensity-my;mx+=dx/p.n;my+=dy/p.n;
          mxx+=dx*(l.intensity-mx);myy+=dy*(r.intensity-my);mxy+=dx*(r.intensity-my);
        }
        x=await left.next();y=await right.next();
      }
      p.correlation=mxx>0&&myy>0?Math.max(-1,Math.min(1,mxy/Math.sqrt(mxx*myy))):null;
      p.difference=p.n?p.rain_a-p.rain_b:null;p.ratio=p.rain_b?p.rain_a/p.rain_b:null;pairs.push(p);
    }
    return {pairs};
  }
  async export(params,send,signal){
    const {selected,start,end}=await this.selection(params),ready=await this.ready();
    let text="\ufeff"+["device","logger_minute",...NUMERIC,"weather"].join(";")+"\r\n";
    for(const device of selected){
      for await(const row of this.iterate(device,start,end,ready,signal)){
        const date=new Date(row.ts*1000).toISOString().slice(0,16);
        text+=[device,date,...NUMERIC.map(k=>row[k]),row.weather].map(csvCell).join(";")+"\r\n";
        if(text.length>256*1024){await send(text);text="";}
      }
    }
    if(text)await send(text);
    return {ok:true};
  }
  async clear(){
    if(this.running)throw Error("Bitte den laufenden Import abwarten.");
    return navigator.locks.request(this.name+"-write",async()=>{
      const tx=this.db.transaction(["devices","samples","attempts","imports"],"readwrite"),done=completed(tx);
      for(const name of ["samples","attempts","imports","devices"])tx.objectStore(name).clear();
      for(const d of defaults())tx.objectStore("devices").put({...d,first:null,last:null,minutes:0});
      await done;this.results=[];
    });
  }
  async demo(){
    if(this.mode!=="demo"||(await this.ready()).size>=3)return;
    await navigator.locks.request(this.name+"-write",async()=>{
      const imported=new Set((await this.all("imports")).filter(i=>i.status==="done").map(i=>i.device));
      await this.cleanStaging();
      const first=timestamp("2026-07-20 00:00");
      for(const [device,factor] of [["wald1",.72],["wald2",.8],["lichtung",1]]){
        if(imported.has(device))continue;
        const source=identifier(),info={id:source,device,filename:"Künstliche Beispieldaten",created:Date.now(),status:"importing",
          rows:0,accepted:0,errors:0,duplicates:0,conflicts:0,bad_bytes:0,checksum_unchecked:0,examples:[]};
        {
          const tx=this.db.transaction("imports","readwrite"),done=completed(tx);
          tx.objectStore("imports").put(info);await done;
        }
        let rows=[],attempts=[];
        for(let minute=0;minute<7*1440;minute++){
          const ts=first+minute*60;
          if(device==="wald2"&&minute>3700&&minute<3770)continue;
          attempts.push({source,device,ts});info.rows++;
          if(device==="wald1"&&minute>6200&&minute<6230){info.errors++;continue;}
          let intensity=0;
          for(const [centre,spread,peak] of [[1050,85,9],[3340,130,18],[6650,105,28],[9050,170,6]]){
            if(Math.abs(minute-centre)<spread*2)intensity+=peak*Math.exp(-(((minute-centre)/spread)**2))*factor*(1+.16*Math.sin(minute*4.3+factor*8));
          }
          if(intensity<.04)intensity=0;
          const interior=12+5*Math.sin(minute/1440*2*Math.PI-1.6),particles=Math.floor(intensity*(160+40*Math.sin(minute)));
          const sparse=[];
          if(particles)for(let i=0;i<22;i++){const n=Math.floor(particles*Math.exp(-i/2.2)/2.8);if(n)sparse.push(i*20+Math.min(19,4+i),n);}
          const warnings=Number(device==="wald2"&&minute>6600&&minute<6660);
          rows.push({source,device,ts,intensity,particles,quality:minute>6690&&minute<6710?65:96,
            interior,laser_temp:interior+10,supply:12.8,control:4010+9*warnings,heater_laser:170-interior*4,
            heater_receiver:161-interior*3.8,ambient:interior-.5,warnings,weather:intensity?"Regen":"Trocken",
            flags:{sensor_supply:warnings},spectrum:new Uint16Array(sparse),serial:"DEMO"});
          info.accepted++;
          if(rows.length>=500||minute===7*1440-1){
            const tx=this.db.transaction(["samples","attempts"],"readwrite"),done=completed(tx);
            for(const row of rows)tx.objectStore("samples").put(row);
            for(const row of attempts)tx.objectStore("attempts").put(row);
            await done;rows=[];attempts=[];
          }
        }
        const tx=this.db.transaction(["devices","imports"],"readwrite"),done=completed(tx),store=tx.objectStore("devices");
        const get=store.get(device);
        get.onsuccess=()=>{
          store.put({...get.result,first,last:first+(7*1440-1)*60,minutes:info.accepted});
          tx.objectStore("imports").put({...info,status:"done"});
        };
        await done;
      }
    });
  }
}
