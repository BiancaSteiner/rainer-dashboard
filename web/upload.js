"use strict";
window.rainerUpload = (() => {
  const pendingKey="rainer-pending-upload";
  let busy=false,settings=null;

  function pending() {
    try{return JSON.parse(localStorage.getItem(pendingKey)||"null");}catch{return null;}
  }
  function savePending(value) {
    if(value)localStorage.setItem(pendingKey,JSON.stringify(value));
    else localStorage.removeItem(pendingKey);
  }
  function message(text) {$("upload-message").textContent=text;}
  async function write(url,options={}) {
    const response=await fetch(url,{...options,headers:{"X-LNM-Token":meta.token,...options.headers}});
    if(response.status===401){window.location.assign("/login");throw Error("Bitte erneut anmelden.");}
    const result=await response.json().catch(()=>({error:"Der Server konnte die Anfrage nicht abschließen."}));
    if(!response.ok){const error=Error(result.error);error.status=response.status;throw error;}
    return result;
  }
  function refresh(current) {
    if(!current.online)return;
    settings=current;
    const previous=$("upload-device").value;
    const options=current.configured.map(d=>{
      const option=document.createElement("option");option.value=d.key;option.textContent=d.name;return option;
    });
    $("upload-device").replaceChildren(...options);
    if(current.configured.some(d=>d.key===previous))$("upload-device").value=previous;
    if(!previous)updateId();
    $("upload-button").disabled=busy||current.import_state.running;
    $("resume-import").disabled=busy||current.import_state.running;
  }
  function updateId() {
    const d=settings?.configured.find(d=>d.key===$("upload-device").value);
    if(d)$("upload-id").value=d.id;
  }
  async function inspectPending() {
    const item=pending();
    if(!item||!meta?.online)return;
    try{
      const status=await api("/api/uploads/"+item.upload);
      if(status.phase==="done"){
        savePending(null);$("resume-import").classList.add("hidden");
      }else if(status.phase==="processing"){
        message("Die übertragene Datei wird auf dem Server eingelesen.");pollImport();
      }else if(status.phase==="error"){
        message("Ein Import wurde unterbrochen. Du kannst ihn mit der gespeicherten Datei fortsetzen.");
        $("resume-import").classList.remove("hidden");
      }else{
        message("Ein Upload ist noch offen. Wähle dieselbe Datei erneut aus, um die Übertragung fortzusetzen.");
      }
    }catch(e){message(e.message);}
  }
  async function begin(file,device,id,encoding) {
    const old=pending();
    if(old&&old.name===file.name&&old.size===file.size&&old.modified===file.lastModified
       &&old.device===device&&old.id===id&&old.encoding===encoding) {
      try{
        const status=await api("/api/uploads/"+old.upload);
        if(status.phase==="upload")return {...old,received:new Set(status.received)};
        if(status.phase==="error")return {...old,retryImport:true};
        if(status.phase==="processing")throw Error("Dieser Import läuft bereits auf dem Server.");
      }catch(e){if(e.message.includes("läuft bereits"))throw e;}
    }
    const result=await write("/api/uploads",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({device,id,encoding,name:file.name,size:file.size})});
    const item={upload:result.upload,name:file.name,size:file.size,modified:file.lastModified,device,id,encoding};
    savePending(item);return {...item,received:new Set()};
  }
  async function sendPart(item,index,payload) {
    for(let attempt=0;attempt<5;attempt++){
      try{
        return await write("/api/uploads/"+item.upload+"/"+index,{
          method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:payload});
      }catch(e){
        if(e.status&&e.status<500||attempt===4)throw e;
        message("Verbindung unterbrochen. Der Uploadblock wird erneut gesendet …");
        await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
      }
    }
  }
  async function finish(identifier) {
    await write("/api/uploads/"+identifier+"/finish",{method:"POST"});
    message("Übertragung abgeschlossen. Die CSV wird auf dem Server eingelesen.");
    $("resume-import").classList.add("hidden");
    await pollImport();
    const result=await api("/api/uploads/"+identifier);
    if(result.phase==="done"){
      savePending(null);
      message("Datei eingelesen. Die Daten sind jetzt im Dashboard verfügbar.");
    }else{
      message("Die Übertragung ist abgeschlossen. Bitte das Importprotokoll prüfen.");
      $("resume-import").classList.remove("hidden");
    }
  }
  $("upload-device").addEventListener("change",updateId);
  $("upload-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const file=$("upload-file").files[0];
    if(!file||busy)return;
    if(file.size>meta.max_upload_bytes){message("Die Datei überschreitet das konfigurierte Uploadlimit.");return;}
    busy=true;$("upload-button").disabled=true;
    $("upload-progress").classList.remove("hidden");$("upload-progress").value=0;
    const fields=$("upload-form").querySelectorAll("input,select");
    fields.forEach(e=>e.disabled=true);
    try{
      message("Upload wird vorbereitet …");
      const item=await begin(file,$("upload-device").value,$("upload-id").value,$("upload-encoding").value);
      if(!item.retryImport){
        for(let start=0,index=0;start<file.size;start+=meta.chunk_bytes,index++){
          const end=Math.min(file.size,start+meta.chunk_bytes);
          if(!item.received.has(index))await sendPart(item,index,file.slice(start,end));
          const percent=Math.round(end/file.size*100);
          $("upload-progress").value=percent;
          message("Übertragung "+percent+" % · "+fmt(end/1024**2,1)+" von "+fmt(file.size/1024**2,1)+" MB");
        }
      }
      await finish(item.upload);
      $("upload-file").value="";
      await refreshMeta();
    }catch(e){
      message(e.message+" Wähle bei einer unterbrochenen Übertragung dieselbe Datei erneut aus.");
    }finally{
      busy=false;fields.forEach(e=>e.disabled=false);$("upload-button").disabled=false;
    }
  });
  $("resume-import").addEventListener("click",async()=>{
    const item=pending();if(!item||busy)return;
    busy=true;$("resume-import").disabled=true;
    try{await finish(item.upload);}catch(e){message(e.message);}
    finally{busy=false;$("resume-import").disabled=false;}
  });
  document.querySelector('[data-view="import"]').addEventListener("click",()=>{if(meta?.online)inspectPending();});
  return {refresh};
})();
