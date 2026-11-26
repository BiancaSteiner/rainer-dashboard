"use strict";
window.localData=(()=>{
  const worker=new Worker(new URL("./worker.mjs",document.baseURI),{type:"module"});
  const pending=new Map();
  let next=0,failure=null;
  const key="rainer-mode-"+new URL(".",document.baseURI).pathname;
  function call(command,args={},signal,onChunk){
    if(failure)return Promise.reject(failure);
    return new Promise((resolve,reject)=>{
      const id=++next;
      if(signal?.aborted){reject(new DOMException("Abgebrochen","AbortError"));return;}
      const abort=()=>{worker.postMessage({id,command:"cancel"});pending.delete(id);reject(new DOMException("Abgebrochen","AbortError"));};
      signal?.addEventListener("abort",abort,{once:true});
      pending.set(id,{resolve,reject,onChunk,signal,abort});
      worker.postMessage({id,command,args});
    });
  }
  worker.onmessage=async({data})=>{
    const item=pending.get(data.id);
    if(data.chunk!=null){
      try{if(item)await item.onChunk(data.chunk);}
      catch(error){item?.reject(error);worker.postMessage({id:data.id,command:"cancel"});}
      finally{worker.postMessage({id:data.id,command:"ack"});}
      return;
    }
    if(!item)return;
    if(data.progress){document.dispatchEvent(new CustomEvent("lnm-progress",{detail:data.progress}));return;}
    item.signal?.removeEventListener("abort",item.abort);pending.delete(data.id);
    if(data.error){const error=Error(data.error.message);error.name=data.error.name;item.reject(error);}
    else item.resolve(data.result);
  };
  worker.onerror=()=>{
    failure=Error("Die Browser-Verarbeitung konnte nicht gestartet werden. Bitte die veröffentlichte HTTPS-Adresse in einem aktuellen Browser öffnen.");
    for(const item of pending.values())item.reject(failure);pending.clear();
  };
  let saved="demo";
  try{saved=localStorage.getItem(key)||"demo";}catch{}
  const initialized=call("mode",{mode:saved==="own"?"own":"demo"});
  return {
    async api(url,signal){await initialized;return call("api",{url},signal);},
    async mode(mode){
      await initialized;
      try{localStorage.setItem(key,mode);}catch{}
      return call("mode",{mode});
    },
    async import(files,options){await initialized;return call("import",{mode:"own",files,options});},
    async clear(){return call("clear",{mode:"own"});},
    async export(params){
      let writable=null;
      if(window.showSaveFilePicker){
        try{
          const file=await window.showSaveFilePicker({suggestedName:"lnm-auswahl.csv",
            types:[{description:"CSV-Messwerte",accept:{"text/csv":[".csv"]}}]});
          writable=await file.createWritable();
        }catch(error){if(error.name==="AbortError")return;throw error;}
      }
      const parts=[];
      try{
        await call("export",{params:String(params)},undefined,chunk=>writable?writable.write(chunk):parts.push(chunk));
        if(writable)await writable.close();
        else{
          const url=URL.createObjectURL(new Blob(parts,{type:"text/csv;charset=utf-8"}));
          const a=document.createElement("a");a.href=url;a.download="lnm-auswahl.csv";a.click();
          setTimeout(()=>URL.revokeObjectURL(url),30000);
        }
      }catch(error){if(writable)await writable.abort();throw error;}
    }
  };
})();
