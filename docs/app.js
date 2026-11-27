"use strict";
const $=id=>document.getElementById(id);
const COLORS=["#087d79","#cd7b32","#636cb5","#a05782"];
const TITLES={overview:"Tropfen und kinetische Energie",comparison:"Spektren und Differenzen vergleichen",import:"Eigene Messdaten einlesen"};
const charts=new Map(),maps=new Map();
let meta,overview,selected=[],view="overview",requestVersion=0,activeController,lastKey=null,settingsMode=null;
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=(value,decimals=3)=>value==null?"—":Number(value).toLocaleString("de-DE",{maximumFractionDigits:decimals});
const axisNumber=value=>value!==0&&Math.abs(value)<.01?value.toExponential(1).replace(".",","):fmt(value,2);
const stamp=ts=>new Date(ts*1000).toLocaleString("de-DE",{timeZone:"UTC",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
const inputDate=ts=>new Date(ts*1000).toISOString().slice(0,16);
const inputEpoch=id=>Date.parse($(id).value+"Z")/1000;
const name=key=>meta.devices.find(d=>d.key===key)?.name||key;
const color=key=>COLORS[Math.max(0,meta.devices.findIndex(d=>d.key===key))%COLORS.length];
function notify(message,error=false){$("notice").innerHTML=message?'<div class="'+(error?"error-message":"info-message")+'">'+esc(message)+'</div>':"";}
function api(url,signal){return window.localData.api(url,signal);}
function table(id,headers,rows){
  $(id).innerHTML=rows.length?'<table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join("")+'</tr></thead><tbody>'+
    rows.map(row=>'<tr>'+row.map(c=>'<td>'+c+'</td>').join("")+'</tr>').join("")+'</tbody></table>':'<p class="hint">Für diese Auswahl sind keine Daten vorhanden.</p>';
}
function getAU(){
  const values={};$("areas").querySelectorAll("input").forEach(input=>{values[input.dataset.device]=input.value;});return values;
}
function areaKey(){return "rainer-au-"+new URL(".",document.baseURI).pathname+"-"+(meta.demo?"demo":"own");}
function renderAreas(){
  if(settingsMode===(meta.demo?"demo":"own")&&$("areas").children.length)return;
  settingsMode=meta.demo?"demo":"own";
  let values={};try{values=JSON.parse(localStorage.getItem(areaKey())||"{}");}catch{}
  $("areas").replaceChildren(...meta.devices.map(d=>{
    const label=document.createElement("label");label.textContent=d.name+" · AU";
    const input=document.createElement("input");input.type="number";input.min="850";input.max="1200";input.step="1";
    input.placeholder="850–1200";input.dataset.device=d.key;input.value=values[d.key]??(meta.demo?"1000":"");
    const result=document.createElement("span");result.className="muted";
    const show=()=>{const v=Number(input.value);result.textContent=input.value&&v>=850&&v<=1200?"Messfläche "+fmt(46000/v,3)+" cm²":"Messfläche noch unbekannt";};
    input.addEventListener("change",()=>{
      show();try{localStorage.setItem(areaKey(),JSON.stringify(getAU()));}catch{}
      if($("unit").value==="area")load(true);
    });
    label.append(input,result);show();return label;
  }));
}
function params(){
  const start=inputEpoch("start"),end=inputEpoch("end");
  if(!selected.length)throw Error("Bitte mindestens ein Gerät auswählen.");
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw Error("Bitte einen gültigen Zeitraum auswählen.");
  return new URLSearchParams({devices:selected.join(","),start,end,resolution:$("resolution").value,dry:$("dry").value,
    common:$("common").checked?"1":"0",unit:$("unit").value,au:JSON.stringify(getAU()),focus:"rain"});
}
function bounds(){
  const devices=meta.devices.filter(d=>selected.includes(d.key)&&d.first!=null);
  return devices.length?[Math.min(...devices.map(d=>d.first)),Math.max(...devices.map(d=>d.last))]:null;
}
function setRange(start,end){$("start").value=inputDate(start);$("end").value=inputDate(end);}
function clearPreset(){document.querySelectorAll("[data-hours]").forEach(b=>b.classList.remove("selected"));}
function choosePreset(hours){
  const range=bounds();if(!range)return;
  setRange(hours==="all"?range[0]:Math.max(range[0],range[1]-Number(hours)*3600+60),range[1]);
  document.querySelectorAll("[data-hours]").forEach(b=>b.classList.toggle("selected",b.dataset.hours===String(hours)));
  load();
}
function shiftRange(direction){
  const range=bounds();if(!range)return;
  const width=inputEpoch("end")-inputEpoch("start")+60;
  let start=inputEpoch("start")+width*direction,end=inputEpoch("end")+width*direction;
  if(start<range[0]){start=range[0];end=Math.min(range[1],start+width-60);}
  if(end>range[1]){end=range[1];start=Math.max(range[0],end-width+60);}
  setRange(start,end);clearPreset();load();
}
function selectedView(next){
  activeController?.abort();requestVersion++;view=next;$("page-title").textContent=TITLES[next];
  document.querySelectorAll(".view").forEach(e=>e.classList.toggle("hidden",e.id!=="view-"+next));
  document.querySelectorAll("[data-view]").forEach(e=>e.classList.toggle("active",e.dataset.view===next));
  $("data-content").classList.toggle("hidden",next==="import"||!bounds());
  $("empty").classList.toggle("hidden",next==="import"||!!bounds());
  if(next==="import")renderImport();else load();
}
function tip(event,html){
  const el=$("tooltip");el.innerHTML=html;el.classList.remove("hidden");
  const box=el.getBoundingClientRect();
  el.style.left=Math.max(8,Math.min(innerWidth-box.width-10,event.clientX+17))+"px";
  el.style.top=Math.max(8,Math.min(innerHeight-box.height-10,event.clientY+13))+"px";
}
function hideTip(){$("tooltip").classList.add("hidden");}
function nearest(points,target){
  let lo=0,hi=points.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].x<target)lo=mid+1;else hi=mid;}
  if(!lo)return points[0];if(lo===points.length)return points.at(-1);
  return target-points[lo-1].x<points[lo].x-target?points[lo-1]:points[lo];
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
    if(this.options.symmetric){const edge=Math.max(Math.abs(this.lo),Math.abs(this.hi));this.lo=-edge;this.hi=edge;}
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
      ctx.fillStyle="#69808a";ctx.fillText(axisNumber(v),this.left-9,y+4);
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

function units(){
  return overview.normalized?{count:"Tropfen/m²",rate:"Tropfen/(m²·min)",energy:"J/m²",energyRate:"J/(m²·min)"}:
    {count:"Tropfen",rate:"Tropfen/min",energy:"J",energyRate:"J/min"};
}
function scalar(field){
  return overview.series.map(s=>({label:name(s.device),color:color(s.device),
    points:s.points.map(p=>({x:p.ts,y:p[field],extra:
      field==="diameter"?"Anzahlgewichtetes Mittel der Klassen unter 8 mm":
      field==="interior"?p.n+" vorhandene Telegramme im Zeitabschnitt":
      p.valid+" genutzte Minuten · "+p.open+" Tropfen in offener Klasse ab 8 mm"}))}));
}
function blend(a,b,t){return "rgb("+a.map((v,i)=>Math.round(v+(b[i]-v)*t)).join(",")+")";}
function heatColor(value,max,diverging=false){
  if(value==null)return "#dce3e6";
  if(!value)return "#f4f6f6";
  if(diverging){
    const t=Math.min(1,Math.abs(value)/(max||1));
    return blend([247,247,247],value<0?[46,101,170]:[213,117,36],t);
  }
  const log=$("log-color").checked;
  const t=Math.min(1,log?Math.log1p(value)/Math.log1p(max||1):value/(max||1));
  return blend([233,246,239],[3,83,73],t);
}
function legend(id,max,unit,diverging=false){
  const target=$(id),ticks=diverging?[-1,-.5,0,.5,1]:[0,.25,.5,.75,1];
  const gradient=diverging?"linear-gradient(to right,#2e65aa,#f7f7f7,#d57524)":"linear-gradient(to right,#e9f6ef,#035349)";
  target.innerHTML='<div class="legend-bar" style="background:'+gradient+'"></div><div class="legend-ticks">'+ticks.map(f=>{
    const value=diverging?f*max:$("log-color").checked?Math.expm1(f*Math.log1p(max)):f*max;
    return "<span>"+esc(axisNumber(value))+"</span>";
  }).join("")+'</div><p class="muted">'+esc(unit)+(diverging?" · symmetrisch um 0":$("log-color").checked?" · logarithmisch":" · linear")+'</p>';
}
class Heatmap {
  constructor(id,kind){
    this.id=id;this.kind=kind;this.element=$(id);this.canvas=document.createElement("canvas");
    this.element.replaceChildren(this.canvas);
    this.canvas.addEventListener("pointermove",e=>this.hover(e));this.canvas.addEventListener("pointerleave",hideTip);
    this.canvas.addEventListener("pointerdown",e=>{
      if(this.kind!=="time")return;
      this.drag=this.timeAt(e);this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointerup",e=>{
      if(this.drag==null)return;
      const end=this.timeAt(e),start=this.drag;this.drag=null;
      if(Math.abs(end-start)>overview.step){setRange(Math.floor(Math.min(start,end)/60)*60,Math.floor(Math.max(start,end)/60)*60);clearPreset();load();}
    });
    this.canvas.addEventListener("dblclick",()=>{if(this.kind==="time")choosePreset("all");});
    this.observer=new ResizeObserver(()=>this.draw());this.observer.observe(this.element);
  }
  update(data,max,unit,diverging=false){this.data=data;this.max=max;this.unit=unit;this.diverging=diverging;this.draw();}
  draw(){
    const width=this.element.clientWidth,height=this.element.clientHeight;
    if(!this.data||!width)return;
    const ratio=devicePixelRatio||1;this.canvas.width=width*ratio;this.canvas.height=height*ratio;
    const c=this.canvas.getContext("2d");c.scale(ratio,ratio);c.fillStyle="#fff";c.fillRect(0,0,width,height);
    this.left=65;this.right=width-18;this.top=25;this.bottom=height-35;
    const dx=d=>this.left+(d-.125)/(8.5-.125)*(this.right-this.left);
    const dy=d=>this.bottom-(d-.125)/(8.5-.125)*(this.bottom-this.top);
    const vy=v=>this.bottom-v/20*(this.bottom-this.top);
    const tx=t=>this.left+(t-overview.start)/(overview.end+60-overview.start)*(this.right-this.left);
    c.fillStyle="#dce3e6";c.fillRect(this.left,this.top,this.right-this.left,this.bottom-this.top);
    c.save();c.beginPath();c.rect(this.left,this.top,this.right-this.left,this.bottom-this.top);c.clip();
    if(this.kind==="time"){
      this.byTime=new Map(this.data.points.map(p=>[p.ts,p]));
      for(const p of this.data.points)for(let di=0;di<22;di++){
        const low=overview.diameter[di],high=overview.diameter[di+1]??8.5;
        c.fillStyle=heatColor(p.sizes[di],this.max);
        c.fillRect(tx(p.ts),dy(high),Math.max(.5,tx(p.ts+overview.step)-tx(p.ts)),dy(low)-dy(high)+.2);
      }
    }else{
      for(let di=0;di<22;di++)for(let vi=0;vi<20;vi++){
        const low=overview.diameter[di],high=overview.diameter[di+1]??8.5;
        c.fillStyle=heatColor(this.data.matrix[di*20+vi],this.max,this.diverging);
        c.fillRect(dx(low),vy(overview.speed[vi+1]),dx(high)-dx(low)+.2,vy(overview.speed[vi])-vy(overview.speed[vi+1])+.2);
      }
    }
    c.restore();c.font='12px "Segoe UI",Arial';c.fillStyle="#617d86";c.textAlign="right";
    if(this.kind==="time"){
      for(const d of [.125,1,2,4,6,8])c.fillText(d===8?"≥8":String(d),this.left-10,dy(d)+4);
      c.textAlign="left";c.fillText("Durchmesser [mm]",this.left,this.top-8);c.textAlign="center";
      const n=width<500?3:5;
      for(let i=0;i<n;i++){
        const t=overview.start+(overview.end+60-overview.start)*i/(n-1);
        const date=new Date(t*1000);
        const text=overview.end-overview.start<86400?date.toISOString().slice(11,16):
          date.toLocaleDateString("de-DE",{timeZone:"UTC",day:"2-digit",month:"2-digit"});
        c.fillText(text,tx(t),height-10);
      }
    }else{
      for(const v of [0,1,3,5,10,20])c.fillText(v,this.left-10,vy(v)+4);
      c.textAlign="left";c.fillText("Fallgeschwindigkeit [m/s]",this.left,this.top-8);c.textAlign="center";
      for(const d of [.125,1,2,4,6,8])c.fillText(d===8?"≥8":String(d),dx(d),height-12);
    }
    const minutes=this.kind==="time"?this.data.summary.valid:this.data.n??this.data.spectrum_minutes;
    if(!minutes){c.fillStyle="#536d76";c.textAlign="center";c.fillText("Keine gemeinsamen bzw. gültigen Minuten",width/2,height/2);}
    this.canvas.setAttribute("role","img");this.canvas.setAttribute("aria-label",this.data.label+" · "+this.unit);
  }
  timeAt(e){
    const x=e.clientX-this.canvas.getBoundingClientRect().left;
    return Math.max(overview.start,Math.min(overview.end,overview.start+(x-this.left)/(this.right-this.left)*(overview.end+60-overview.start)));
  }
  hover(e){
    if(!this.data)return;
    const box=this.canvas.getBoundingClientRect(),x=e.clientX-box.left,y=e.clientY-box.top;
    if(x<this.left||x>this.right||y<this.top||y>this.bottom){hideTip();return;}
    let html="<strong>"+esc(this.data.label)+"</strong>";
    if(this.kind==="time"){
      const ts=Math.floor(this.timeAt(e)/overview.step)*overview.step,p=this.byTime.get(ts);
      const diameter=.125+(this.bottom-y)/(this.bottom-this.top)*(8.5-.125);
      const di=Math.max(0,overview.diameter.findLastIndex(d=>d<=diameter));
      html+=esc(stamp(ts))+"<br>Durchmesser "+fmt(overview.diameter[di],3)+(di===21?" mm und größer":" bis "+fmt(overview.diameter[di+1],3)+" mm");
      html+="<br><b>"+fmt(p?.sizes[di],6)+" "+esc(this.unit)+"</b>";
      html+='<br><span class="muted">'+(p?p.valid+" genutzte Minuten im Abschnitt":"Keine gültige Messung")+"</span>";
    }else{
      const d=.125+(x-this.left)/(this.right-this.left)*(8.5-.125),v=(this.bottom-y)/(this.bottom-this.top)*20;
      const di=Math.max(0,overview.diameter.findLastIndex(a=>a<=d)),vi=Math.max(0,overview.speed.slice(0,20).findLastIndex(a=>a<=v));
      html+="Durchmesser "+fmt(overview.diameter[di],3)+(di===21?" mm und größer":" bis "+fmt(overview.diameter[di+1],3)+" mm");
      html+="<br>Geschwindigkeit "+fmt(overview.speed[vi],2)+" bis "+fmt(overview.speed[vi+1],2)+" m/s";
      html+="<br><b>"+fmt(this.data.matrix[di*20+vi],6)+" "+esc(this.unit)+"</b>";
    }
    tip(e,html);
  }
  save(){
    const a=document.createElement("a");a.href=this.canvas.toDataURL("image/png");a.download="rainer-"+this.id+".png";a.click();
  }
}
function heatmap(id,kind,data,max,unit,diverging=false){
  if(!maps.has(id))maps.set(id,new Heatmap(id,kind));
  maps.get(id).update(data,max,unit,diverging);
}
function gallery(id,kind){
  const parent=$(id),expected=overview.series.map(s=>s.device).join("|");
  if(parent.dataset.devices!==expected){
    for(const [key,map]of maps)if(map.element.parentElement?.parentElement===parent){map.observer.disconnect();maps.delete(key);}
    parent.replaceChildren(...overview.series.map(s=>{
      const block=document.createElement("section"),title=document.createElement("h3"),chart=document.createElement("div");
      title.textContent=name(s.device);chart.id=kind+"-"+s.device;chart.className=kind==="time"?"time-heatmap":"spectrum-heatmap";
      block.append(title,chart);return block;
    }));
    parent.dataset.devices=expected;
  }
  for(const s of overview.series){
    heatmap(kind+"-"+s.device,kind,{...s,label:name(s.device)},kind==="time"?overview.scales.time_max:overview.scales.spectrum_max,units().rate);
  }
}
function renderStats(){
  const u=units();
  $("stats").innerHTML=overview.series.map(s=>{
    const q=s.summary;
    return '<div class="stat"><div class="stat-label"><i class="swatch" style="background:'+color(s.device)+'"></i>'+esc(name(s.device))+
      '</div><div class="stat-value">'+fmt(q.energy,6)+' <small>'+u.energy+
      '</small></div><div class="stat-caption">Kinetische Energie · D &lt; 8 mm</div>'+
      '<div class="stat-detail"><span>Tropfen</span><span>'+fmt(q.count,1)+" "+u.count+'</span></div>'+
      '<div class="stat-detail"><span>Mittlerer Durchmesser</span><span>'+fmt(q.mean_diameter,3)+' mm</span></div>'+
      '<div class="stat-detail"><span>Genutzte Minuten</span><span>'+fmt(q.valid,0)+" / "+fmt(q.expected,0)+'</span></div>'+
      '<div class="stat-detail"><span>Tropfen ≥8 mm</span><span>'+fmt(q.open,0)+'</span></div></div>';
  }).join("");
  $("coverage-note").textContent=(overview.common?"Gemeinsame gültige Datenbasis · "+fmt(overview.common_minutes,0)+" Minuten":
    "Je Gerät werden dessen verfügbare gültige Minuten genutzt.")+
    " · Farbskalen gelten gemeinsam für alle ausgewählten Geräte. Temperaturen und Ereignisse nutzen die jeweils verfügbaren Daten.";
}
function renderEvents(){
  const u=units();
  table("events",["Gerät","Start","Ende","Dauer [min]","Nassminuten","Regen [mm]",u.count,"Energie D<8 mm ["+u.energy+"]","Tropfen ≥8 mm"],
    overview.events.map(e=>[esc(name(e.device)),esc(stamp(e.start)),esc(stamp(e.end)),fmt((e.end-e.start)/60+1,0),fmt(e.wet,0),
      fmt(e.rain,3),fmt(e.particles,2),fmt(e.energy,8),fmt(e.open,0)]));
  $("events").querySelectorAll("tbody tr").forEach((tr,i)=>{
    tr.classList.add("event-row");tr.tabIndex=0;
    const open=()=>{setRange(overview.events[i].start,overview.events[i].end);clearPreset();load();};
    tr.addEventListener("click",open);tr.addEventListener("keydown",e=>{if(e.key==="Enter")open();});
  });
  const note=document.createElement("p");note.className="hint";
  note.textContent=(overview.events_limited?"Es werden bis zu 500 Ereignisse angezeigt. ":"")+"Ereignisse am Fensterrand können abgeschnitten sein. Tropfenanzahl und Energie beziehen sich hier auf die Nassminuten des jeweiligen Geräts.";
  $("events").append(note);
}
function renderOverview(){
  const u=units();renderStats();
  legend("time-legend",overview.scales.time_max,u.rate);gallery("time-maps","time");
  plot("drops",scalar("count"),{unit:u.rate,decimals:4});
  plot("diameter",scalar("diameter"),{unit:"mm",zero:false,decimals:4});
  plot("energy",scalar("energy"),{unit:u.energyRate,decimals:8});
  plot("cumulative",scalar("cumulative"),{unit:u.energy,decimals:8,steps:true});
  plot("temperature",scalar("interior"),{unit:"°C",zero:false,decimals:2});
  plot("intensity",scalar("intensity"),{unit:"mm/h",steps:true,decimals:3});
  renderEvents();
}
function renderDifference(){
  const pair=overview.pairs[Number($("pair").value)||0],u=units();
  if(!pair){
    $("pair-note").textContent="Bitte mindestens zwei Geräte auswählen.";
    $("difference-map").classList.add("hidden");$("difference-legend").classList.add("hidden");
    $("save-difference").disabled=true;
    plot("difference-drops",[],{unit:u.rate,symmetric:true});
    plot("difference-energy",[],{unit:u.energyRate,symmetric:true});
    return;
  }
  $("difference-map").classList.remove("hidden");$("difference-legend").classList.remove("hidden");
  $("save-difference").disabled=false;
  const label=name(pair.a)+" minus "+name(pair.b);
  $("pair-note").textContent=label+" · "+fmt(pair.n,0)+" gemeinsame gültige Minuten";
  legend("difference-legend",overview.scales.difference_max,u.rate,true);
  heatmap("difference-map","spectrum",{matrix:pair.matrix,n:pair.n,label},overview.scales.difference_max,u.rate,true);
  for(const [id,field,unit]of [["difference-drops","count",u.rate],["difference-energy","energy",u.energyRate]]){
    plot(id,[{label,color:"#5b658e",points:pair.points.map(p=>({x:p.ts,y:p[field],extra:p.n+" gemeinsame Minuten"}))}],
      {unit,symmetric:true,decimals:8});
  }
}
function renderComparison(){
  const u=units();
  legend("spectrum-legend",overview.scales.spectrum_max,u.rate);gallery("spectrum-maps","spectrum");
  $("spectrum-note").textContent=overview.series.map(s=>name(s.device)+" · "+fmt(s.spectrum_minutes,0)+" Minuten").join(" · ")+
    ". Alle Farbwerte sind mittlere Anzahlen pro Minute und Klasse; die Farbskala ist für alle Geräte identisch.";
  plot("sizes",overview.series.map(s=>({label:name(s.device),color:color(s.device),
    points:s.sizes.map((value,i)=>({x:i,y:value,extra:i===21?"Offene Klasse ab 8 mm":
      fmt(overview.diameter[i],3)+" bis "+fmt(overview.diameter[i+1],3)+" mm"}))})),
    {category:true,labels:overview.diameter.map((d,i)=>(i===21?"≥":"")+fmt(d,3)),unit:u.rate,decimals:6});
  const old=$("pair").value;
  $("pair").innerHTML=overview.pairs.map((p,i)=>'<option value="'+i+'">'+esc(name(p.a))+" minus "+esc(name(p.b))+"</option>").join("");
  $("pair").value=old!==""&&overview.pairs[Number(old)]?old:overview.pairs.length?"0":"";
  renderDifference();
  table("comparison",["Gerät A","Gerät B","Gemeinsame Minuten","Tropfen A ["+u.count+"]","Tropfen B ["+u.count+"]",
    "Mittleres D A [mm]","Mittleres D B [mm]","Energie A ["+u.energy+"]","Energie B ["+u.energy+"]","ΔE A−B ["+u.energy+"]"],
    overview.pairs.map(p=>[esc(name(p.a)),esc(name(p.b)),fmt(p.n,0),fmt(p.count_a,2),fmt(p.count_b,2),
      fmt(p.mean_diameter_a,4),fmt(p.mean_diameter_b,4),fmt(p.energy_a,8),fmt(p.energy_b,8),fmt(p.energy_difference,8)]));
}
function render(){if(view==="overview")renderOverview();else if(view==="comparison")renderComparison();}
async function load(force=false){
  if(view==="import")return;
  if(!selected.length){notify("Bitte mindestens ein Gerät auswählen.",true);$("data-content").classList.add("hidden");$("export").disabled=true;return;}
  if(!bounds()){overview=null;$("data-content").classList.add("hidden");$("empty").classList.remove("hidden");$("export").disabled=true;return;}
  let query;try{query=params();}catch(e){notify(e.message,true);return;}
  $("data-content").classList.remove("hidden");$("empty").classList.add("hidden");
  if(!force&&overview&&lastKey===String(query)){render();return;}
  const version=++requestVersion;activeController?.abort();activeController=new AbortController();
  $("data-content").classList.add("busy");notify("Tropfen, Energie und gemeinsame Datenbasis werden berechnet …");
  try{
    const result=await api("/api/analysis?"+query,activeController.signal);
    if(version!==requestVersion)return;
    overview=result;lastKey=String(query);render();$("export").disabled=false;
    $("footer-range").textContent=stamp(result.start)+" bis "+stamp(result.end)+" · "+fmt(result.step/60,0)+"-Minuten-Darstellung";
    const noCommon=result.common&&!result.common_minutes;
    notify(noCommon?"Keine gemeinsamen gültigen Minuten. Zeitraum oder Geräteauswahl anpassen; alternativ die gemeinsame Datenbasis ausschalten.":
      meta.demo?"Künstliche Beispieldaten · AU 1000 ist ausschließlich für die Demo vorbelegt.":"",noCommon);
  }catch(error){
    if(error.name!=="AbortError"){notify(error.message,true);$("data-content").classList.add("hidden");}
  }finally{if(version===requestVersion)$("data-content").classList.remove("busy");}
}
async function refreshMeta(initial=false){
  meta=await api("/api/meta");
  if(initial){selected=meta.devices.map(d=>d.key);lastKey=null;}
  $("mode").textContent=meta.demo?"Beispieldaten":"Eigene Browserdaten";$("mode").classList.toggle("demo",meta.demo);
  $("dataset").value=meta.demo?"demo":"own";
  $("devices").innerHTML=meta.devices.map(d=>'<label class="device-check"><input type="checkbox" value="'+esc(d.key)+'" '+
    (selected.includes(d.key)?"checked":"")+'><i class="swatch" style="background:'+color(d.key)+'"></i>'+esc(d.name)+"</label>").join("");
  $("devices").querySelectorAll("input").forEach(input=>input.addEventListener("change",()=>{
    selected=[...$("devices").querySelectorAll("input:checked")].map(i=>i.value);
    load();
  }));
  renderAreas();window.browserImport?.refresh(meta);
  const b=bounds();$("availability").textContent=b?"Verfügbar "+stamp(b[0])+" – "+stamp(b[1]):"Noch keine Messdaten";
  if(b&&(initial||!$("start").value||!$("end").value))setRange(Math.max(b[0],b[1]-86340),b[1]);
  $("import-status").textContent=meta.import_state.message;
  return meta.import_state;
}
async function renderImport(){
  try{
    await refreshMeta();
    table("config-table",["Standort","Schlüssel","Logger-ID"],meta.configured.map(d=>[esc(d.name),esc(d.key),esc(d.id)]));
    const history=await api("/api/imports");
    table("import-history",["Gerät","Datei","Status","Übernommene Minuten","Fehler","Duplikate","Konflikte","Fehlerbeispiele"],
      history.map(h=>[esc(name(h.device)),esc(h.filename),esc(h.status),fmt(h.accepted,0),fmt(h.errors,0),fmt(h.duplicates,0),fmt(h.conflicts,0),
        h.examples.length?'<details><summary>'+h.examples.length+" Beispiele</summary>"+h.examples.map(e=>"<p>Zeile "+e.line+" · "+esc(e.error)+"</p>").join("")+"</details>":"—"]));
    $("import-results").innerHTML=meta.import_state.results.map(r=>"<p><b>"+esc(name(r.device))+"</b> · "+esc(r.file||"")+" · "+
      esc(r.status)+(r.accepted!=null?" · "+fmt(r.accepted,0)+" Minuten":"")+(r.error?" · "+esc(r.error):"")+"</p>").join("");
  }catch(error){notify(error.message,true);}
}
document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>selectedView(b.dataset.view)));
document.querySelectorAll("[data-hours]").forEach(b=>b.addEventListener("click",()=>choosePreset(b.dataset.hours)));
$("apply").addEventListener("click",()=>{clearPreset();load();});
$("previous").addEventListener("click",()=>shiftRange(-1));$("next").addEventListener("click",()=>shiftRange(1));
for(const id of ["resolution","dry","common","unit"])$(id).addEventListener("change",()=>{
  if(id==="unit"&&$("unit").value==="area")document.querySelector(".area-settings").open=true;
  load(true);
});
$("log-color").addEventListener("change",()=>{if(overview)render();});
$("pair").addEventListener("change",renderDifference);
$("empty-import").addEventListener("click",()=>selectedView("import"));
$("export").addEventListener("click",async()=>{try{await window.localData.export(params());}catch(e){notify(e.message,true);}});
document.querySelectorAll(".save-image").forEach(b=>b.addEventListener("click",()=>charts.get(b.dataset.chart)?.save()));
$("save-spectrum").addEventListener("click",()=>{for(const s of overview?.series||[])maps.get("spectrum-"+s.device)?.save();});
$("save-difference").addEventListener("click",()=>maps.get("difference-map")?.save());
$("dataset").addEventListener("change",async()=>{
  activeController?.abort();requestVersion++;lastKey=null;settingsMode=null;overview=null;
  try{await window.localData.mode($("dataset").value);await refreshMeta(true);if(view==="import")await renderImport();else await load();}
  catch(e){notify(e.message,true);}
});
refreshMeta(true).then(()=>load()).catch(e=>notify(e.message,true));
