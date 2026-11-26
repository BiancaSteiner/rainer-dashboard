import test from "node:test";
import assert from "node:assert/strict";
const {indexedDB,IDBKeyRange}=await import(process.env.RAINER_TEST_INDEXEDDB||"fake-indexeddb");
import {parseTelegram,timestamp,csvRows,Overview,EventDetector} from "../docs/lnm.mjs";
import {BrowserData} from "../docs/database.mjs";
import {locks} from "node:worker_threads";

globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
Object.defineProperty(navigator,"locks",{value:locks,configurable:true});

function frame({date="23.07.2026 03:55:08",intensity=6,separator=";",bad=false,ending="\r\n"}={}){
  const fields=Array(520).fill("0");
  fields.splice(0,5,"\x0201","4128","1.20","01.01.21","20:33:41");
  fields[11]=intensity?"RA":"NP";fields[12]=String(intensity);fields[13]=String(intensity);
  fields[18]="100";fields.splice(36,9,"12","22","0661","4010","1500","130","120","125","99999");
  fields[49]="4";fields[79+2*20+5]="4";fields[519]="AA";
  if(bad)fields[79]="\ufffd";
  return [date,"01",...fields].join(separator)+ending;
}
const file=(text,name="test.csv")=>new File([text],name,{type:"text/csv"});
const collect=async iterator=>{const rows=[];for await(const row of iterator)rows.push(row);return rows;};
async function database(mode="own"){
  return new BrowserData(crypto.randomUUID(),mode).open();
}
async function importText(db,text,device="wald1"){
  return db.importFiles([file(text)],{device,id:"01",encoding:"utf-8"},()=>{});
}

test("Telegrammzuordnung, Einheiten, offene Werte und Spektrum",async()=>{
  const rows=await collect(csvRows(file(frame())));
  const r=parseTelegram(rows[0].cells,rows[0].raw);
  assert.equal(r.ts,timestamp("2026-07-23 03:55"));assert.equal(r.supply,13);assert.equal(r.ambient,null);
  assert.equal(r.intensity,6);assert.equal(r.particles,4);assert.deepEqual([...r.spectrum],[45,4]);
  assert.equal(r.sensor_time,"01.01.21 20:33:41");
});
test("Prüfsumme über vollständig erhaltenen Rahmen",async()=>{
  let raw=frame().replace(/AA\r\n$/,";\r\n\x03\r\n");
  const start=raw.indexOf("\x02"),end=raw.indexOf("\x03")+1,body=raw.slice(start,end);
  const check=((256-[...body].reduce((a,c)=>a+c.charCodeAt(0),0)%256)%256).toString(16).toUpperCase().padStart(2,"0");
  raw=raw.replace(/;;\r\n\x03/,";"+check+";\r\n\x03");
  const rows=await collect(csvRows(file(raw)));
  assert.equal(parseTelegram(rows[0].cells,rows[0].raw).checksum,"ok");
  rows[0].raw=rows[0].raw.replace("4128","4129");
  assert.throws(()=>parseTelegram(rows[0].cells,rows[0].raw),/Prüfsumme/);
});
test("Tabulatoren, Endmarker und CR-Zeilenenden",async()=>{
  for(const separator of [";","\t",","])for(const ending of ["\n","\r\n","\r"]){
    const text=frame({separator,ending})+"\x03"+separator.repeat(3)+ending+frame({separator,ending});
    const rows=await collect(csvRows(file(text)));
    assert.equal(rows.length,2);assert.equal(rows[0].cells[1],"01");
  }
});
test("UTF-16 und über Byteblöcke geteilte UTF-8-Felder",async()=>{
  const text=frame().replace("1.20","Feb 70");
  const encoded=new Uint8Array(2+text.length*2);encoded.set([255,254]);
  for(let i=0;i<text.length;i++){encoded[2+i*2]=text.charCodeAt(i)%256;encoded[3+i*2]=text.charCodeAt(i)>>8;}
  assert.equal((await collect(csvRows(new File([encoded],"utf16.csv"),"utf-16"))).length,1);
  const base=file(text),bytes=new TextEncoder().encode(text);
  const streamed={size:base.size,slice:(...args)=>base.slice(...args),stream:()=>new ReadableStream({
    start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}
  })};
  assert.equal((await collect(csvRows(streamed)))[0].cells[4],"Feb 70");
});
test("Zeitstempel werden streng und ohne Sommerzeitverschiebung gelesen",()=>{
  assert.equal(timestamp("23.07.2026 03:55"),timestamp("2026-07-23T03:55"));
  assert.throws(()=>timestamp("31.02.2026 04:00"));
  assert.throws(()=>timestamp("2026-07-23T03:55+02:00"));
});
test("Doppelte und widersprüchliche Minuten werden korrekt gezählt",async()=>{
  const db=await database();
  await importText(db,frame());
  const result=await importText(db,frame({intensity:12})+frame({intensity:12})+frame());
  assert.equal(result[0].accepted,0);assert.equal(result[0].duplicates,1);assert.equal(result[0].conflicts,2);
  const t=timestamp("23.07.2026 03:55"),data=await db.overview(new URLSearchParams({devices:"wald1",start:t,end:t}));
  assert.equal(data.series[0].summary.telegrams,1);assert.equal(data.series[0].summary.rain,.1);
  db.db.close();
});
test("Fehler, fehlende Minuten und Partikelklassenzuordnung",async()=>{
  const db=await database();
  await importText(db,frame()+frame({date:"23.07.2026 03:56",bad:true})+frame({date:"23.07.2026 03:58",intensity:3}));
  const t=timestamp("23.07.2026 03:55"),p=new URLSearchParams({devices:"wald1",start:t,end:t+180});
  const q=(await db.overview(p)).series[0].summary;
  assert.equal(q.telegrams,2);assert.equal(q.missing,2);assert.equal(q.missing_logger,1);
  assert.ok(Math.abs(q.rain-.15)<1e-12);
  const s=(await db.spectrum(p)).series[0];assert.equal(s.matrix[45],8);assert.equal(s.sizes[2],8);
  assert.equal((await db.events(p)).events.length,2);db.db.close();
});
test("Dateifehler nach mehr als einem Schreibbatch werden atomar verborgen",async()=>{
  const db=await database();
  let text="";
  for(let i=0;i<510;i++){
    const d=new Date(Date.UTC(2026,6,23,0,i));text+=frame({date:d.toISOString().slice(0,16)});
  }
  const result=await importText(db,text+'"unvollständig\n');
  assert.equal(result[0].status,"Fehler");
  const meta=await db.meta();assert.equal(meta.devices.find(d=>d.key==="wald1").minutes,0);
  const q=await db.overview(new URLSearchParams({devices:"wald1",start:timestamp("23.07.2026 00:00"),end:timestamp("24.07.2026 00:00")}));
  assert.equal(q.series[0].summary.telegrams,0);
  await importText(db,frame());
  assert.equal((await db.all("samples")).length,1);db.db.close();
});
test("Gerätevergleich verwendet ausschließlich gemeinsame gültige Minuten",async()=>{
  const db=await database();
  await importText(db,frame()+frame({date:"23.07.2026 03:56",intensity:60}));
  await importText(db,frame({intensity:3}),"lichtung");
  const pair=(await db.comparison(new URLSearchParams({devices:"wald1,lichtung",start:timestamp("23.07.2026 03:55"),end:timestamp("23.07.2026 03:56")}))).pairs[0];
  assert.equal(pair.n,1);assert.equal(pair.rain_a,.1);assert.equal(pair.rain_b,.05);assert.equal(pair.correlation,null);
  db.db.close();
});
test("Eine Million Minuten werden mit begrenzter Zahl von Diagrammabschnitten aggregiert",()=>{
  const a=new Overview(0,999999*60,86400);
  const r={ts:0,intensity:6,particles:4,quality:100,warnings:0,control:4010,weather:"Regen",flags:{},interior:12};
  for(let i=0;i<1000000;i++){r.ts=i*60;a.add(r);}
  assert.equal(a.bins.size,695);assert.ok(!Array.isArray(a.bins.get(0)));
  const summary=a.finish("test",1000000);assert.equal(summary.summary.telegrams,1000000);
  assert.ok(Math.abs(summary.summary.rain-100000)<.001);assert.equal(summary.points.length,695);
});
test("Trockenpause und Datenlücke trennen Ereignisse",()=>{
  const detector=new EventDetector("wald1",30);
  for(let i=0;i<40;i++)detector.add({ts:i*60,intensity:i===0||i===31?6:0,particles:4,quality:90});
  assert.equal(detector.finish().events.length,2);
});
test("Export enthält Originalminuten und Reset entfernt eigene Browserdaten",async()=>{
  const db=await database();await importText(db,frame());
  const parts=[];await db.export(new URLSearchParams({devices:"wald1"}),chunk=>parts.push(chunk));
  assert.ok(parts[0].startsWith("\ufeffdevice;logger_minute"));assert.ok(parts.join("").includes("wald1;2026-07-23T03:55;6;4;100"));
  await db.clear();assert.equal((await db.all("samples")).length,0);assert.equal((await db.history()).length,0);db.db.close();
});
test("Beispieldaten bleiben von eigenen Daten getrennt",async()=>{
  const db=await database("demo");await db.demo();
  assert.equal((await db.meta()).devices.length,3);assert.equal((await db.ready()).size,3);
  assert.ok((await db.meta()).devices.every(d=>d.minutes>10000));
  await assert.rejects(()=>db.importFiles([file(frame())],{device:"wald1",id:"01"},()=>{}),/eigene CSVs/);
  db.db.close();
});
