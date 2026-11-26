"use strict";
const $ = id => document.getElementById(id);
const COLORS = ["#087d79", "#cd7b32", "#636cb5", "#a05782", "#55843d", "#b55754"];
const WEATHER = {"Trocken":"#dfe8ea","Regen":"#228f9c","Niesel":"#80cad1","Regen und Niesel":"#399c82",
  "Schneeregen":"#99a3d8","Schnee":"#727dc5","Schneegriesel":"#b09ecb","Graupel/Eiskörner":"#d09c59",
  "Hagel":"#a56391","Sensorfehler":"#bd594b","Unbestimmt":"#a69577"};
const TITLES = {overview:"Niederschlag im Überblick",comparison:"Disdrometer vergleichen",
  spectrum:"Ein Blick in die Partikel",health:"Geräte und Heizung",quality:"Wie vollständig sind die Daten?",
  import:"Deine Messdaten einlesen"};
const FLAGS = {laser_off:"Laser aus",static_signal:"Statisches Signal",laser_temp_analog:"Lasertemperatur analog",
  laser_temp_digital:"Lasertemperatur digital",laser_current_analog:"Laserstrom analog",
  laser_current_digital:"Laserstrom digital",sensor_supply:"Sensorversorgung",heater_laser:"Scheibenheizung Laserkopf",
  heater_receiver:"Scheibenheizung Empfängerkopf",temperature_sensor:"Temperaturfühler",heater_supply:"Heizversorgung",
  heater_housing:"Gehäuseheizung",heater_heads:"Kopfheizung",heater_carriers:"Trägerheizung",laser_control:"Laserregelung"};
let meta, overview, spectrum, view = "overview", selected = [], requestVersion = 0, activeController;
const charts = new Map();
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (value, decimals=2) => value == null ? "—" : Number(value).toLocaleString("de-DE", {maximumFractionDigits:decimals});
const stamp = ts => new Date(ts*1000).toLocaleString("de-DE",{timeZone:"UTC",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
const inputDate = ts => new Date(ts*1000).toISOString().slice(0,16);
const inputEpoch = id => Date.parse($(id).value+"Z")/1000;
const name = key => meta.devices.find(d => d.key===key)?.name || key;
const color = key => COLORS[Math.max(0,meta.devices.findIndex(d=>d.key===key))%COLORS.length];
function notify(message, error=false) {
  $("notice").innerHTML = message ? `<div class="${error?"error-message":"info-message"}">${esc(message)}</div>` : "";
}
async function api(url, signal) {
  const response = await fetch(url,{signal});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Anfrage fehlgeschlagen.");
  return data;
}
function params() {
  const start=inputEpoch("start"), end=inputEpoch("end");
  if(!selected.length) throw Error("Bitte mindestens ein Gerät auswählen.");
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start) throw Error("Bitte einen gültigen Zeitraum auswählen.");
  return new URLSearchParams({devices:selected.join(","),start,end,resolution:$("resolution").value,dry:$("dry").value});
}
function table(id, headers, rows) {
  $(id).innerHTML = rows.length ? `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>` : '<p class="hint">Für diese Auswahl sind keine Daten vorhanden.</p>';
}
function bounds() {
  const ds=meta.devices.filter(d=>selected.includes(d.key)&&d.first!=null);
  return ds.length ? [Math.min(...ds.map(d=>d.first)),Math.max(...ds.map(d=>d.last))] : null;
}
function setRange(first,last) { $("start").value=inputDate(first);$("end").value=inputDate(last); }
function choosePreset(hours) {
  const range=bounds();
  if(!range) return;
  setRange(hours==="all"?range[0]:Math.max(range[0],range[1]-Number(hours)*3600+60),range[1]);
  document.querySelectorAll("[data-hours]").forEach(b=>b.classList.toggle("selected",b.dataset.hours===String(hours)));
  load();
}
function shiftRange(direction) {
  const start=inputEpoch("start"),end=inputEpoch("end"),range=bounds();
  if(!range)return;
  const width=end-start+60;
  let first=start+width*direction,last=end+width*direction;
  if(first<range[0]) {first=range[0];last=Math.min(range[1],first+width-60);}
  if(last>range[1]) {last=range[1];first=Math.max(range[0],last-width+60);}
  setRange(first,last);clearPreset();load();
}
function clearPreset(){document.querySelectorAll("[data-hours]").forEach(b=>b.classList.remove("selected"));}
function selectedView(next) {
  activeController?.abort();requestVersion++;
  view=next;
  $("page-title").textContent=TITLES[next];
  document.querySelectorAll(".view").forEach(e=>e.classList.toggle("hidden",e.id!==`view-${next}`));
  document.querySelectorAll("[data-view]").forEach(e=>e.classList.toggle("active",e.dataset.view===next));
  $("data-content").classList.toggle("hidden",next==="import"||!overview?.series.some(s=>s.summary.expected>0));
  $("empty").classList.toggle("hidden",next==="import"||overview?.series.some(s=>s.summary.expected>0));
  $("export").disabled=next==="import"||!overview?.series.some(s=>s.points.length);
  if(next==="import") renderImport();
  else load();
}
function tip(event, html) {
  const el=$("tooltip");
  el.innerHTML=html;
  el.classList.remove("hidden");
  const box=el.getBoundingClientRect();
  el.style.left=Math.max(8,Math.min(window.innerWidth-box.width-10,event.clientX+17))+"px";
  el.style.top=Math.max(8,Math.min(window.innerHeight-box.height-10,event.clientY+13))+"px";
}
function hideTip(){$("tooltip").classList.add("hidden");}
function nearest(points,target) {
  let lo=0,hi=points.length;
  while(lo<hi) {const mid=(lo+hi)>>1;if(points[mid].x<target)lo=mid+1;else hi=mid;}
  if(lo===0)return points[0];
  if(lo===points.length)return points.at(-1);
  return target-points[lo-1].x < points[lo].x-target ? points[lo-1] : points[lo];
}

class Plot {
  constructor(id) {
    this.id=id;this.element=$(id);this.canvas=document.createElement("canvas");this.overlay=document.createElement("canvas");
    this.overlay.style.position="absolute";this.overlay.style.inset="0";
    this.canvas.setAttribute("role","img");
    this.element.replaceChildren(this.canvas,this.overlay);
    this.overlay.addEventListener("pointermove",e=>this.hover(e));
    this.overlay.addEventListener("pointerleave",()=>{hideTip();this.clearOverlay();});
    this.overlay.addEventListener("pointerdown",e=>{
      if(this.options.category)return;
      this.drag=this.toX(e);this.overlay.setPointerCapture(e.pointerId);
    });
    this.overlay.addEventListener("pointerup",e=>{
      if(this.drag==null)return;
      const finish=this.toX(e),start=this.drag;this.drag=null;
      if(Math.abs(finish-start)>80&&Math.abs(this.x(finish)-this.x(start))>12) {
        setRange(Math.floor(Math.min(start,finish)/60)*60,Math.floor(Math.max(start,finish)/60)*60);
        clearPreset();load();
      }this.clearOverlay();
    });
    this.overlay.addEventListener("dblclick",()=>choosePreset("all"));
    this.observer=new ResizeObserver(()=>this.draw());this.observer.observe(this.element);
  }
  update(series,options={}) {this.series=series;this.options=options;this.draw();}
  setup(canvas,width,height) {
    const ratio=window.devicePixelRatio||1;
    canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
    const ctx=canvas.getContext("2d");ctx.scale(ratio,ratio);return ctx;
  }
  draw() {
    if(!this.series||!this.element.clientWidth)return;
    const width=this.element.clientWidth,height=this.element.clientHeight;
    this.w=width;this.h=height;
    const ctx=this.setup(this.canvas,width,height);this.setup(this.overlay,width,height);
    ctx.fillStyle="#fff";ctx.fillRect(0,0,width,height);ctx.font='12px "Segoe UI",Arial';
    let lx=65,ly=13;
    this.series.forEach(s=>{
      const length=ctx.measureText(s.label).width+30;
      if(lx+length>width-10){lx=65;ly+=17;}
      ctx.fillStyle=s.color;ctx.fillRect(lx,ly-7,9,3);ctx.fillStyle="#52717a";ctx.fillText(s.label,lx+14,ly-2);lx+=length;
    });
    this.top=ly+26;this.bottom=height-37;this.left=65;this.right=width-15;
    let lo=this.options.zero===false?Infinity:0,hi=-Infinity,hasData=false;
    for(const s of this.series) for(const p of s.points) if(p.y!=null&&Number.isFinite(p.y)){
      lo=Math.min(lo,p.y);hi=Math.max(hi,p.y);hasData=true;
    }
    if(this.options.band){lo=Math.min(lo,this.options.band[0]);hi=Math.max(hi,this.options.band[1]);}
    if(!Number.isFinite(lo))lo=0;if(!Number.isFinite(hi))hi=1;
    const margin=(hi-lo)*.08||Math.max(Math.abs(hi)*.03,1);
    this.lo=this.options.zero===false?lo-margin:Math.min(lo,0);this.hi=hi+margin;
    this.xmin=this.options.category?0:overview.start;
    this.xmax=this.options.category?21:overview.end+60;
    this.x=v=>this.left+(v-this.xmin)/(this.xmax-this.xmin||1)*(this.right-this.left);
    this.y=v=>this.bottom-(v-this.lo)/(this.hi-this.lo)*(this.bottom-this.top);
    if(this.options.band){
      ctx.fillStyle="#e8f4ed";ctx.fillRect(this.left,this.y(this.options.band[1]),this.right-this.left,this.y(this.options.band[0])-this.y(this.options.band[1]));
    }
    ctx.textAlign="right";
    for(let i=0;i<5;i++){
      const v=this.lo+(this.hi-this.lo)*i/4,y=this.y(v);
      ctx.strokeStyle="#e5edef";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(this.left,y);ctx.lineTo(this.right,y);ctx.stroke();
      ctx.fillStyle="#69808a";ctx.fillText(fmt(v,Math.abs(v)<5?2:1),this.left-9,y+4);
    }
    ctx.textAlign="left";ctx.fillStyle="#69808a";ctx.fillText(this.options.unit||"",this.left,this.top-8);
    const ticks=width<500?3:5;
    ctx.textAlign="center";
    for(let i=0;i<ticks;i++){
      const v=this.xmin+(this.xmax-this.xmin)*i/(ticks-1);
      let label;
      if(this.options.category)label=(this.options.labels[Math.round(v)]??"")+" mm";
      else{
        const d=new Date(v*1000);
        label=(this.xmax-this.xmin<=86400)?d.toISOString().slice(11,16):d.toLocaleDateString("de-DE",{timeZone:"UTC",day:"2-digit",month:"2-digit"});
      }
      ctx.fillText(label,this.x(v),height-12);
    }
    ctx.save();ctx.beginPath();ctx.rect(this.left,this.top,this.right-this.left,this.bottom-this.top);ctx.clip();
    for(const s of this.series){
      ctx.strokeStyle=s.color;ctx.lineWidth=1.7;
      if(s.dash)ctx.setLineDash([5,4]);else ctx.setLineDash([]);
      ctx.beginPath();let prev=null;
      for(const p of s.points){
        if(p.y==null){prev=null;continue;}
        const px=this.x(p.x),py=this.y(p.y);
        if(!prev||(!this.options.category&&p.x-prev.x>overview.step*1.5))ctx.moveTo(px,py);
        else if(this.options.steps){ctx.lineTo(px,this.y(prev.y));ctx.lineTo(px,py);}
        else ctx.lineTo(px,py);
        prev=p;
      }ctx.stroke();
      if(s.points.filter(p=>p.y!=null).length===1){
        const p=s.points.find(p=>p.y!=null);ctx.beginPath();ctx.arc(this.x(p.x),this.y(p.y),3,0,7);ctx.fillStyle=s.color;ctx.fill();
      }
    }ctx.restore();
    if(!hasData){ctx.textAlign="center";ctx.fillStyle="#72858b";ctx.fillText("Keine gültigen Messwerte in diesem Zeitraum",width/2,height/2);}
    this.canvas.setAttribute("aria-label",`${this.options.title||this.id}. ${this.series.map(s=>s.label).join(", ")}. Werte im CSV-Export verfügbar.`);
  }
  toX(event) {
    const box=this.overlay.getBoundingClientRect();
    return Math.max(this.xmin,Math.min(this.xmax,this.xmin+(event.clientX-box.left-this.left)/(this.right-this.left)*(this.xmax-this.xmin)));
  }
  clearOverlay(){this.overlay.getContext("2d").clearRect(0,0,this.overlay.width,this.overlay.height);}
  hover(event) {
    if(!this.series||!this.x)return;
    const target=this.toX(event),ctx=this.overlay.getContext("2d");
    this.clearOverlay();
    const x=this.x(target);
    if(this.drag!=null){ctx.fillStyle="#087d7922";ctx.fillRect(Math.min(x,this.x(this.drag)),this.top,Math.abs(x-this.x(this.drag)),this.bottom-this.top);hideTip();return;}
    ctx.strokeStyle="#779499";ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(x,this.top);ctx.lineTo(x,this.bottom);ctx.stroke();
    let html=`<strong>${this.options.category?"Durchmesserklasse "+esc(this.options.labels[Math.round(target)])+" mm":esc(stamp(Math.floor(target/overview.step)*overview.step))}</strong>`;
    let found=false;
    for(const s of this.series){
      const p=nearest(s.points,target);
      if(!p||(!this.options.category&&Math.abs(p.x-target)>overview.step))continue;
      const suffix=this.options.category?"":` <span class="muted">${esc(stamp(p.x))}</span>`;
      html+=`<div><span style="color:${s.color}">■</span> ${esc(s.label)} ${fmt(p.y,this.options.decimals??3)} ${esc(this.options.unit||"")}${suffix}</div>`;
      if(p.extra)html+=`<div class="muted">${esc(p.extra)}</div>`;
      found=true;
    }
    if(!found)html+='<span class="muted">Keine Messung in der Nähe</span>';
    if(!this.options.category&&overview.step>60)html+=`<div class="muted">Zeitabschnitt ${fmt(overview.step/60,0)} Minuten</div>`;
    tip(event,html);
  }
  save(){
    const a=document.createElement("a");a.href=this.canvas.toDataURL("image/png");a.download=`rainer-${this.id}.png`;a.click();
  }
}
function plot(id,series,options) {
  if(!charts.has(id))charts.set(id,new Plot(id));
  charts.get(id).update(series,options);
}
function seriesFor(field,suffix="",options={}) {
  return overview.series.map(s=>({label:name(s.device)+suffix,color:color(s.device),dash:options.dash,
    points:s.points.map(p=>({x:p.ts,y:p[field],extra:
      field==="intensity"?`Mittel ${fmt(p.intensity_mean,3)} mm/h · ${p.valid}/${p.n} gültige Intensitäten`:
      field==="supply"?`Minimum ${fmt(p.supply_min,3)} · Maximum ${fmt(p.supply_max,3)} V`:
      field==="control"?`Minimum ${fmt(p.control_min,1)} · Maximum ${fmt(p.control_max,1)} mV`:
      field==="quality"?`Mittel ${fmt(p.quality_mean,2)} %`:
      `${p.n} Telegrammminute${p.n===1?"":"n"}`}))}));
}
function renderStats() {
  const summaries=overview.series.map(s=>({device:s.device,...s.summary}));
  const maximum=key=>summaries.some(s=>s[key]!=null)?Math.max(...summaries.filter(s=>s[key]!=null).map(s=>s[key])):null;
  const total=key=>summaries.some(s=>s[key]!=null)?summaries.reduce((a,s)=>a+(s[key]||0),0):null;
  const metrics=[
    {label:"Niederschlag",key:"rain",unit:"mm",headline:maximum("rain"),caption:"Höchste Gerätesumme im Zeitfenster",digits:3},
    {label:"Maximale Minutenintensität",key:"peak",unit:"mm/h",headline:maximum("peak"),caption:"Höchster beobachteter Minutenwert",digits:2},
    {label:"Partikelanzahl",key:"particles",unit:"",headline:total("particles"),caption:"Summe der ausgewählten Geräte",digits:0},
    {label:"Gültige Intensitäten",key:"coverage",unit:"%",headline:summaries.length?summaries.reduce((a,s)=>a+s.coverage,0)/summaries.length:0,caption:"Mittlere zeitliche Abdeckung",digits:1}
  ];
  $("stats").innerHTML=metrics.map(m=>`<div class="stat"><div class="stat-label">${m.label}</div><div class="stat-value">${fmt(m.headline,m.digits)} <small>${m.unit}</small></div>${summaries.map(s=>`<div class="stat-detail"><span><i class="swatch" style="background:${color(s.device)}"></i>${esc(name(s.device))}</span><span>${fmt(s[m.key],m.digits)} ${m.unit}</span></div>`).join("")}<div class="stat-caption">${m.caption}</div></div>`).join("");
}
function renderWeather() {
  const kinds=new Set();
  $("weather").replaceChildren();
  for(const s of overview.series){
    const row=document.createElement("div");row.className="weather-row";
    const label=document.createElement("span");label.textContent=name(s.device);
    const bar=document.createElement("div");bar.className="weather-bar";
    const grouped=new Map();
    for(const r of s.weather){if(!grouped.has(r.ts))grouped.set(r.ts,[]);grouped.get(r.ts).push(r);}
    for(const [ts,types] of grouped){
      const kind=types[0].weather;kinds.add(kind);
      const block=document.createElement("span");block.className="weather-run";
      const left=Math.max(overview.start,ts),right=Math.min(overview.end+60,ts+overview.step);
      block.style.left=((left-overview.start)/(overview.end+60-overview.start)*100)+"%";
      block.style.width=((right-left)/(overview.end+60-overview.start)*100)+"%";
      block.style.background=WEATHER[kind]||"#aaa";
      block.addEventListener("pointermove",e=>tip(e,`<strong>${esc(name(s.device))} · ${esc(stamp(ts))}</strong>`+types.map(r=>`${esc(r.weather)} · ${r.n} Minute${r.n===1?"":"n"}`).join("<br>")));
      block.addEventListener("pointerleave",hideTip);bar.append(block);
    }
    row.append(label,bar);$("weather").append(row);
  }
  const key=document.createElement("div");key.className="weather-key";
  key.innerHTML=[...kinds].map(k=>`<span><i class="swatch" style="background:${WEATHER[k]||"#aaa"}"></i>${esc(k)}</span>`).join("");$("weather").append(key);
}
function renderOverview() {
  renderStats();renderWeather();
  $("resolution-note").textContent=overview.step===60?"Originale Minutenwerte · Loggerzeit":"Höchste Minutenintensität je "+fmt(overview.step/60,0)+" Minuten · Mittelwert und Abdeckung im Tooltip";
  plot("intensity",seriesFor("intensity"),{unit:"mm/h",steps:true,title:"1-Minuten-Intensität"});
  plot("cumulative",seriesFor("cumulative"),{unit:"mm",steps:true,decimals:4,title:"Aufsummierter beobachteter Niederschlag"});
  plot("particles",seriesFor("particles"),{unit:"Partikel",decimals:0,title:"Partikel je Zeitabschnitt"});
}
function renderHealth() {
  plot("temperatures",[...seriesFor("interior"," innen"),...seriesFor("laser_temp"," Laser",{dash:true}),
    ...seriesFor("ambient"," außen",{dash:true})],{unit:"°C",zero:false});
  plot("heaters",[...seriesFor("heater_laser"," Laserkopf"),...seriesFor("heater_receiver"," Empfänger",{dash:true})],{unit:"mA"});
  plot("supply",seriesFor("supply"),{unit:"V",zero:false});
  plot("control",seriesFor("control"),{unit:"mV",zero:false,band:[4005,4015]});
}
function renderQuality() {
  table("quality-table",["Gerät","Erwartet [min]","Telegramme","Gültige Intensität","Abdeckung","Fehlende Telegramme","Ohne Loggerzeile","Ungültige Intensität","Qualität <80 %","Qualität <90 %","Statusminuten","Regelspannung außerhalb"],
    overview.series.map(s=>{const q=s.summary;return[esc(name(s.device)),fmt(q.expected,0),fmt(q.telegrams,0),fmt(q.valid,0),fmt(q.coverage,2)+" %",fmt(q.missing,0),fmt(q.missing_logger,0),fmt(q.invalid,0),fmt(q.low80,0),fmt(q.low90,0),fmt(q.warnings,0),fmt(q.control_bad,0)];}));
  const flags=[];
  for(const s of overview.series)for(const [flag,n]of Object.entries(s.flags))flags.push([esc(name(s.device)),esc(FLAGS[flag]||flag),fmt(n,0)]);
  table("flag-table",["Gerät","Statusflag","Minuten mit Flag"],flags);
  plot("quality",seriesFor("quality"),{unit:"%",zero:false});
  plot("warnings",seriesFor("warnings"),{unit:"Minuten",decimals:0,steps:true});
}
function renderComparison(data) {
  table("comparison",["Gerät A","Gerät B","Gemeinsame Minuten","Niederschlag A [mm]","Niederschlag B [mm]","Differenz A−B [mm]","Quotient A/B","Maximum A [mm/h]","Maximum B [mm/h]","Partikel A","Partikel B","Korrelation"],
    data.pairs.map(p=>[esc(name(p.a)),esc(name(p.b)),fmt(p.n,0),fmt(p.rain_a,4),fmt(p.rain_b,4),fmt(p.difference,4),fmt(p.ratio,3),
      fmt(p.peak_a,3),fmt(p.peak_b,3),fmt(p.particles_a,0),fmt(p.particles_b,0),fmt(p.correlation,3)]));
  if(selected.length<2)$("comparison").innerHTML='<p class="hint">Wähle oben mindestens zwei Geräte aus.</p>';
  plot("compare-rain",seriesFor("intensity"),{unit:"mm/h",steps:true});
}
function renderEvents(data) {
  table("events",["Gerät","Start","Ende","Dauer [min]","Nasse Minuten","Niederschlag [mm]","Maximum [mm/h]","Partikel in Nassminuten","Qualität Minimum"],
    data.events.map(e=>[esc(name(e.device)),esc(stamp(e.start)),esc(stamp(e.end)),fmt((e.end-e.start)/60+1,0),fmt(e.wet,0),
      fmt(e.rain,4),fmt(e.peak,3),fmt(e.particles,0),fmt(e.quality_min,0)+" %"]));
  $("events").querySelectorAll("tbody tr").forEach((tr,i)=>{
    tr.classList.add("event-row");tr.tabIndex=0;tr.setAttribute("aria-label","Ereignis anzeigen");
    const open=()=>{setRange(data.events[i].start,data.events[i].end);clearPreset();load();};
    tr.addEventListener("click",open);tr.addEventListener("keydown",e=>{if(e.key==="Enter")open();});
  });
  const note=document.createElement("p");note.className="hint";
  note.textContent=(data.limited?"Es werden bis zu 500 Ereignisse angezeigt. Wähle einen kürzeren Zeitraum. ":"")+"Ereignisse an den Grenzen des Zeitfensters können abgeschnitten sein.";
  $("events").append(note);
}
function renderSpectrum(data) {
  spectrum=data;
  const old=$("spectrum-device").value;
  $("spectrum-device").innerHTML=data.series.map(s=>`<option value="${esc(s.device)}">${esc(name(s.device))}</option>`).join("");
  if(data.series.some(s=>s.device===old))$("spectrum-device").value=old;
  plot("sizes",data.series.map(s=>({label:`${name(s.device)} · ${fmt(s.minutes,0)} min`,color:color(s.device),
    points:s.sizes.map((count,i)=>({x:i,y:count,extra:i===21?"Offene Klasse ab 8 mm":`${data.diameter[i]} bis ${data.diameter[i+1]} mm`}))})),
    {category:true,labels:data.diameter.map((d,i)=>(i===21?"≥ ":"")+fmt(d,3)),unit:"Partikel",decimals:0});
  drawHeatmap();
}
let heatObserver;
function drawHeatmap(){
  if(!spectrum)return;
  const s=spectrum.series.find(s=>s.device===$("spectrum-device").value);
  if(!s)return;
  const container=$("heatmap");
  if(!container.clientWidth)return;
  const canvas=document.createElement("canvas");container.replaceChildren(canvas);
  const w=container.clientWidth,h=container.clientHeight,ratio=devicePixelRatio||1;
  canvas.width=w*ratio;canvas.height=h*ratio;const c=canvas.getContext("2d");c.scale(ratio,ratio);
  c.fillStyle="white";c.fillRect(0,0,w,h);
  const l=66,r=w-25,top=35,b=h-65;
  const x=d=>l+(d-.125)/(8.5-.125)*(r-l),y=v=>b-v/20*(b-top);
  const maximum=Math.max(...s.matrix),log=Math.log1p(maximum)||1;
  const palette=["#eef5f4","#d4e8e0","#a1cfc0","#64b3a0","#278f83","#006e69","#064d50"];
  for(let di=0;di<22;di++)for(let vi=0;vi<20;vi++){
    const count=s.matrix[di*20+vi],a=spectrum.diameter[di],z=spectrum.diameter[di+1]??8.5;
    const low=spectrum.speed[vi],high=spectrum.speed[vi+1];
    c.fillStyle=palette[count?1+Math.min(5,Math.floor(Math.log1p(count)/log*6)):0];
    c.fillRect(x(a),y(high),x(z)-x(a)+.1,y(low)-y(high)+.1);
  }
  c.font='12px "Segoe UI",Arial';c.fillStyle="#627e86";c.textAlign="right";
  for(const v of [0,1,3,5,10,20])c.fillText(v,l-12,y(v)+4);
  c.textAlign="left";c.fillText("Fallgeschwindigkeit [m/s]",l,18);c.textAlign="center";
  for(const d of [.125,1,2,3,4,5,6,7,8])c.fillText(d===8?"≥8":String(d),x(d),b+22);
  c.fillText("Durchmesser [mm]",(l+r)/2,b+44);
  const note=`${fmt(s.minutes,0)} Telegrammminuten · ${fmt(s.matrix.reduce((a,b)=>a+b,0),0)} Partikel · Klassenmaximum ${fmt(maximum,0)}`;
  c.textAlign="right";c.fillText(note,r,h-2);
  canvas.setAttribute("role","img");canvas.setAttribute("aria-label",`Spektrum ${name(s.device)}. ${note}`);
  canvas.addEventListener("pointermove",e=>{
    const box=canvas.getBoundingClientRect(),px=e.clientX-box.left,py=e.clientY-box.top;
    if(px<l||px>r||py<top||py>b){hideTip();return;}
    const d=.125+(px-l)/(r-l)*(8.5-.125),v=(b-py)/(b-top)*20;
    const di=Math.max(0,spectrum.diameter.findLastIndex(a=>a<=d)),vi=Math.max(0,spectrum.speed.slice(0,20).findLastIndex(a=>a<=v));
    tip(e,`<strong>${esc(name(s.device))}</strong>Durchmesser ${fmt(spectrum.diameter[di],3)} ${di===21?"mm und größer":"bis "+fmt(spectrum.diameter[di+1],3)+" mm"}<br>Geschwindigkeit ${fmt(spectrum.speed[vi],2)} bis ${fmt(spectrum.speed[vi+1],2)} m/s<br><b>${fmt(s.matrix[di*20+vi],0)} Partikel</b>`);
  });canvas.addEventListener("pointerleave",hideTip);
  if(!heatObserver){heatObserver=new ResizeObserver(()=>{if(view==="spectrum")drawHeatmap();});heatObserver.observe(container);}
}
async function load() {
  if(view==="import")return;
  if(!selected.length){notify("Bitte mindestens ein Gerät auswählen.",true);return;}
  const range=bounds();
  if(!range){overview=null;$("data-content").classList.add("hidden");$("empty").classList.remove("hidden");return;}
  let query;
  try{query=params();}catch(e){notify(e.message,true);return;}
  const version=++requestVersion;
  activeController?.abort();activeController=new AbortController();const signal=activeController.signal;
  $("data-content").classList.add("busy");notify("Zeitfenster wird geladen …");
  try{
    const data=await api("/api/overview?"+query,signal);
    if(version!==requestVersion)return;
    overview=data;
    const hasData=data.series.some(s=>s.summary.expected>0);
    $("data-content").classList.toggle("hidden",!hasData);$("empty").classList.toggle("hidden",hasData);
    $("footer-range").textContent=`${stamp(data.start)} bis ${stamp(data.end)} · Loggerzeit · ${fmt(data.step/60,0)}-Minuten-Darstellung`;
    $("export").disabled=!hasData;
    if(view==="overview"){
      renderOverview();
      const eventData=await api("/api/events?"+query,signal);
      if(version!==requestVersion)return;
      renderEvents(eventData);
    }else if(view==="health")renderHealth();
    else if(view==="quality")renderQuality();
    else if(view==="comparison")renderComparison(await api("/api/comparison?"+query,signal));
    else if(view==="spectrum")renderSpectrum(await api("/api/spectrum?"+query,signal));
    if(version!==requestVersion)return;
    notify(meta.demo?"Demonstrationsdaten · künstlich erzeugte Messungen vom 20.–26.07.2026":"");
  }catch(e){if(e.name!=="AbortError")notify(e.message,true);}
  finally{if(version===requestVersion)$("data-content").classList.remove("busy");}
}
async function refreshMeta(initial=false){
  meta=await api("/api/meta");
  if(initial)selected=meta.devices.map(d=>d.key);
  $("mode").textContent=meta.demo?"Demonstrationsdaten":"Lokale Messdaten";$("mode").classList.toggle("demo",meta.demo);
  $("devices").innerHTML=meta.devices.map(d=>`<label class="device-check"><input type="checkbox" value="${esc(d.key)}" ${selected.includes(d.key)?"checked":""}><i class="swatch" style="background:${color(d.key)}"></i>${esc(d.name)}</label>`).join("");
  $("devices").querySelectorAll("input").forEach(input=>input.addEventListener("change",()=>{
    selected=[...$("devices").querySelectorAll("input:checked")].map(i=>i.value);
    if(!selected.length){notify("Bitte mindestens ein Gerät auswählen.",true);return;}
    load();
  }));
  const b=bounds();
  $("availability").textContent=b?`Verfügbar ${stamp(b[0])} – ${stamp(b[1])}`:"Noch keine Messdaten";
  if(b&&(initial||!$("start").value||!$("end").value))setRange(Math.max(b[0],b[1]-86340),b[1]);
  $("import-button").disabled=meta.demo||meta.import_state.running;
  $("import-status").textContent=meta.demo?"Eigene Daten über start.cmd öffnen.":meta.import_state.message;
  return meta.import_state;
}
async function renderImport(){
  try{
    await refreshMeta();
    table("config-table",["Standort","Schlüssel","CSV-Datei / Muster","Logger-ID"],
      meta.configured.map(d=>[esc(d.name),esc(d.key),`<code>${esc(d.csv)}</code>`,esc(d.id)]));
    if(meta.config_error)notify(meta.config_error,true);
    const history=await api("/api/imports");
    table("import-history",["Gerät","Datei","Zeitpunkt","Zeilen","Übernommen","Fehler","Duplikate","Konflikte","Ungültige Bytes","Prüfsumme ungeprüft","Fehlerbeispiele"],
      history.map(h=>[esc(name(h.device)),esc(h.filename),esc(h.imported_at),fmt(h.rows,0),fmt(h.accepted,0),fmt(h.errors,0),
        fmt(h.duplicates,0),fmt(h.conflicts,0),fmt(h.bad_bytes,0),fmt(h.checksum_unchecked,0),
        h.examples.length?`<details><summary>${h.examples.length} Beispiele</summary>${h.examples.map(e=>`<p>Zeile ${e.line} · ${esc(e.error)}</p>`).join("")}</details>`:"—"]));
    renderImportResults(meta.import_state);
    if(meta.import_state.running)pollImport();
  }catch(e){notify(e.message,true);}
}
function renderImportResults(state){
  $("import-results").innerHTML=state.results.map(r=>`<p><b>${esc(name(r.device))}</b> · ${esc(r.file||"")} · ${esc(r.status)}${r.accepted!=null?" · "+fmt(r.accepted,0)+" Minuten übernommen":""}${r.error?" · "+esc(r.error):""}</p>`).join("");
}
let polling=false;
async function pollImport(){
  if(polling)return;
  polling=true;
  try{
    while(true){
      const state=await refreshMeta();renderImportResults(state);
      if(!state.running){if(view==="import")await renderImport();break;}
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
  }catch(e){notify(e.message,true);}finally{polling=false;}
}
document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>selectedView(b.dataset.view)));
document.querySelectorAll("[data-hours]").forEach(b=>b.addEventListener("click",()=>choosePreset(b.dataset.hours)));
$("apply").addEventListener("click",()=>{clearPreset();load();});
$("previous").addEventListener("click",()=>shiftRange(-1));$("next").addEventListener("click",()=>shiftRange(1));
$("resolution").addEventListener("change",load);$("dry").addEventListener("change",load);
$("spectrum-device").addEventListener("change",drawHeatmap);
$("empty-import").addEventListener("click",()=>selectedView("import"));
$("export").addEventListener("click",()=>{try{window.location.href="/api/export?"+params();}catch(e){notify(e.message,true);}});
document.querySelectorAll(".save-image").forEach(b=>b.addEventListener("click",()=>charts.get(b.dataset.chart)?.save()));
$("import-button").addEventListener("click",async()=>{
  try{
    const response=await fetch("/api/import",{method:"POST",headers:{"X-LNM-Token":meta.token}});
    const result=await response.json();if(!response.ok)throw Error(result.error);
    pollImport();
  }catch(e){notify(e.message,true);}
});
refreshMeta(true).then(()=>load()).catch(e=>notify(e.message,true));
