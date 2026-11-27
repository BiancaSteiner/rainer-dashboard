import test from "node:test";
import assert from "node:assert/strict";
import {locks} from "node:worker_threads";
const {indexedDB,IDBKeyRange}=await import(process.env.RAINER_TEST_INDEXEDDB||"fake-indexeddb");
import {BrowserData} from "../docs/database.mjs";
import {dropMetrics,areaFromAU,analyse,exportAnalysis} from "../docs/physics.mjs";
import {timestamp} from "../docs/lnm.mjs";
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
Object.defineProperty(navigator,"locks",{value:locks,configurable:true});
const t=timestamp("2026-07-23 03:55");
const close=(a,b)=>assert.ok(Math.abs(a-b)<=Math.max(1e-14,Math.abs(b)*1e-12),String(a)+" != "+String(b));
function sample({ts=t,entries=[110,2],weather="Regen",intensity=6,interior=20}={}){
  return {ts,spectrum:new Uint16Array(entries),weather,intensity,interior,quality:100,particles:2,
    flags:{},warnings:0,serial:"TEST"};
}
async function fixture(records){
  const db=await new BrowserData(crypto.randomUUID(),"own").open();
  const tx=db.db.transaction(["samples","devices","imports","attempts"],"readwrite");
  const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  for(const [device,rows]of Object.entries(records)){
    const source=crypto.randomUUID();
    tx.objectStore("imports").put({id:source,device,status:"done",created:Date.now()});
    for(const r of rows){
      tx.objectStore("samples").put({...r,device,source});
      tx.objectStore("attempts").put({device,source,ts:r.ts});
    }
    const get=tx.objectStore("devices").get(device);
    get.onsuccess=()=>tx.objectStore("devices").put({...get.result,first:rows.length?Math.min(...rows.map(r=>r.ts)):null,
      last:rows.length?Math.max(...rows.map(r=>r.ts)):null,minutes:rows.length});
  }
  await done;return db;
}
const parameters=extra=>new URLSearchParams({devices:"wald1,lichtung",start:t,end:t+60,resolution:"1",...extra});

test("Energie aus Masse und gemessener Klassen-Geschwindigkeit mit SI-Einheiten",()=>{
  const m=dropMetrics(sample());
  const diameter=1.125e-3,velocity=3.2,n=2;
  const expected=n*.5*1000*Math.PI/6*diameter**3*velocity**2;
  close(m.energy,expected);assert.equal(m.count,2);close(m.diameterSum/m.finiteCount,1.125);
  const fast=dropMetrics(sample({entries:[111,2]}));
  close(fast.energy/m.energy,3.8**2/3.2**2);
});
test("Offene Durchmesserklasse wird gezählt und aus Energie/Mittelwert ausgelassen",()=>{
  const finite=dropMetrics(sample()),open=dropMetrics(sample({entries:[110,2,420,5]}));
  assert.equal(open.count,7);assert.equal(open.open,5);assert.equal(open.finiteCount,2);
  close(open.energy,finite.energy);close(open.diameterSum/open.finiteCount,1.125);
});
test("Trockene Minuten sind null, Schnee und ungültige Intensität bilden Lücken",()=>{
  const dry=dropMetrics(sample({weather:"Trocken",intensity:0}));
  assert.equal(dry.valid,true);assert.equal(dry.count,0);assert.equal(dry.energy,0);
  assert.equal(dropMetrics(sample({weather:"Schnee"})).valid,false);
  assert.equal(dropMetrics(sample({intensity:null})).valid,false);
});
test("Messfläche wird nach der gerätespezifischen Thies-AU-Formel berechnet",()=>{
  close(areaFromAU(1000),.0046);close(areaFromAU(920),.005);
  assert.equal(areaFromAU(""),null);assert.throws(()=>areaFromAU(800));assert.throws(()=>areaFromAU("x"));
});
test("Gemeinsame Minuten sind voreingestellt und verhindern Unterschiede durch Datenlücken",async()=>{
  const db=await fixture({wald1:[sample(),sample({ts:t+60,entries:[110,20],interior:30})],lichtung:[sample()]});
  const result=await analyse(db,parameters());
  assert.equal(result.common_minutes,1);assert.ok(result.series.every(s=>s.summary.valid===1));
  assert.ok(result.series.every(s=>s.summary.count===2));assert.equal(result.pairs[0].energy_difference,0);
  assert.equal(result.scales.difference_max,0);
  close(result.series[0].summary.interior,25);
  const individual=await analyse(db,parameters({common:"0"}));
  assert.equal(individual.series[0].summary.count,22);assert.equal(individual.series[1].summary.count,2);
  assert.equal(individual.pairs[0].n,1);
  db.db.close();
});
test("Eine globale Spektrenskala und symmetrische Differenzgrenze gelten für alle Geräte",async()=>{
  const db=await fixture({wald1:[sample({entries:[110,4]})],lichtung:[sample({entries:[110,2,90,3]})]});
  const result=await analyse(db,parameters());
  assert.equal(result.scales.spectrum_max,4);
  assert.equal(result.scales.time_max,4);
  assert.equal(result.scales.difference_max,3);
  assert.equal(result.pairs[0].matrix[110],2);assert.equal(result.pairs[0].matrix[90],-3);
  const reverse=await analyse(db,parameters({devices:"lichtung,wald1"}));
  assert.equal(reverse.pairs[0].matrix[110],-2);assert.equal(reverse.pairs[0].matrix[90],3);
  assert.equal(reverse.scales.difference_max,result.scales.difference_max);
  db.db.close();
});
test("Unterschiedliche AU-Flächen werden bei Anzahlen, Energie und Differenzen berücksichtigt",async()=>{
  const db=await fixture({wald1:[sample()],lichtung:[sample()]});
  const result=await analyse(db,parameters({unit:"area",au:JSON.stringify({wald1:1000,lichtung:920})}));
  close(result.series[0].summary.count,2/.0046);close(result.series[1].summary.count,2/.005);
  close(result.pairs[0].matrix[110],2/.0046-2/.005);
  close(result.series[0].summary.energy,dropMetrics(sample()).energy/.0046);
  close(result.events.find(e=>e.device==="wald1").particles,2/.0046);
  close(result.events.find(e=>e.device==="wald1").energy,dropMetrics(sample()).energy/.0046);
  await assert.rejects(()=>analyse(db,parameters({unit:"area",au:"{}"})),/AU-Wert/);
  db.db.close();
});
test("Zeit-Größen-Matrix enthält alle Klassen und Minutenlücken als fehlende Werte",async()=>{
  const db=await fixture({wald1:[sample(),sample({ts:t+60,weather:"Schnee"})],lichtung:[sample(),sample({ts:t+60})]});
  const result=await analyse(db,parameters());
  assert.equal(result.series[0].points[0].sizes.length,22);
  assert.equal(result.series[0].points[0].sizes[5],2);
  assert.equal(result.series[0].points[1].energy,null);
  assert.equal(result.series[1].points[1].energy,null);
  assert.equal(result.series[0].points[1].sizes[5],null);
  db.db.close();
});
test("Regenereignisse enthalten Tropfenenergie, offene Klassen und eigene Datenbasis",async()=>{
  const db=await fixture({wald1:[sample(),sample({ts:t+60,entries:[110,3,420,1]})],lichtung:[sample()]});
  const result=await analyse(db,parameters());
  const event=result.events.find(e=>e.device==="wald1");
  assert.equal(event.wet,2);assert.equal(event.particles,6);assert.equal(event.open,1);
  close(event.energy,dropMetrics(sample()).energy+dropMetrics(sample({entries:[110,3,420,1]})).energy);
  assert.equal(result.series[0].summary.count,2);
  db.db.close();
});
test("Energieexport enthält Joule, J/m², AU-Fläche, Klassen und Innentemperatur",async()=>{
  const db=await fixture({wald1:[sample()]});let csv="";
  await exportAnalysis(db,parameters({devices:"wald1",au:JSON.stringify({wald1:1000})}),part=>{csv+=part;});
  assert.ok(csv.includes("energy_finite_classes_J;energy_finite_classes_J_m2;area_m2"));
  const row=csv.trim().split("\r\n")[1].split(";");
  close(Number(row[6]),dropMetrics(sample()).energy);close(Number(row[7]),dropMetrics(sample()).energy/.0046);
  close(Number(row[8]),.0046);assert.equal(Number(row[10]),20);
  db.db.close();
});
test("Abgebrochene Auswertung lässt gespeicherte Daten verfügbar",async()=>{
  const db=await fixture({wald1:[sample()],lichtung:[sample()]}),controller=new AbortController();
  controller.abort();await assert.rejects(()=>analyse(db,parameters(),controller.signal),{name:"AbortError"});
  assert.equal((await analyse(db,parameters())).common_minutes,1);db.db.close();
});
