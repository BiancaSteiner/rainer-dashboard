"use strict";
window.browserImport=(()=>{
  let busy=false;
  function message(text){$("upload-message").textContent=text;}
  function refresh(current){
    const previous=$("upload-device").value;
    $("upload-device").replaceChildren(...current.configured.map(d=>{
      const option=document.createElement("option");option.value=d.key;option.textContent=d.name;return option;
    }));
    if(current.configured.some(d=>d.key===previous))$("upload-device").value=previous;
    if(!previous)updateId();
    $("upload-button").disabled=busy||current.import_state.running;
    $("clear-data").disabled=busy||current.import_state.running||current.demo;
    storageInfo();
  }
  function updateId(){
    const device=meta?.configured.find(d=>d.key===$("upload-device").value);
    if(device)$("upload-id").value=device.id;
  }
  async function storageInfo(){
    try{
      const storage=await navigator.storage.estimate(),persistent=await navigator.storage.persisted();
      $("storage-status").textContent="Browserspeicher dieser Website · "+fmt(storage.usage/1024**2,1)+
        " MB genutzt · verfügbarer Rahmen "+fmt(storage.quota/1024**3,1)+" GB"+
        (persistent?" · dauerhafte Speicherung vom Browser gewährt":" · Originaldateien bitte aufbewahren");
    }catch{$("storage-status").textContent="Deine importierten Daten werden im Browserspeicher abgelegt.";}
  }
  document.addEventListener("lnm-progress",event=>{
    const progress=event.detail;
    $("upload-progress").classList.remove("hidden");$("upload-progress").value=progress.percent||0;
    message(progress.message);$("import-status").textContent=progress.message;
  });
  $("upload-device").addEventListener("change",updateId);
  $("upload-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const files=[...$("upload-file").files];
    if(!files.length||busy)return;
    const options={device:$("upload-device").value,id:$("upload-id").value,encoding:$("upload-encoding").value};
    busy=true;$("dataset").disabled=true;
    const fields=$("upload-form").querySelectorAll("input,select,button");
    fields.forEach(e=>e.disabled=true);
    $("upload-progress").classList.remove("hidden");$("upload-progress").value=0;
    try{
      navigator.storage?.persist?.().catch(()=>{});
      message("Dateien werden für die Verarbeitung auf diesem Gerät vorbereitet …");
      await window.localData.mode("own");await refreshMeta();
      const results=await window.localData.import(files,options);
      $("upload-progress").value=100;
      await refreshMeta(true);await renderImport();
      const failures=results.filter(r=>r.status==="Fehler").length;
      message(failures?"Import abgeschlossen. Bitte die "+failures+" Fehlermeldung(en) im Protokoll prüfen.":
        "Import abgeschlossen. Deine Daten stehen jetzt in Übersicht und Gerätevergleich zur Verfügung.");
      $("upload-file").value="";
    }catch(error){message(error.message);}
    finally{
      busy=false;fields.forEach(e=>e.disabled=false);$("dataset").disabled=false;
      $("clear-data").disabled=meta.demo;await storageInfo();
    }
  });
  $("clear-data").addEventListener("click",async()=>{
    if(busy||meta.demo)return;
    if(!confirm("Alle eigenen importierten Messdaten und Importprotokolle dieses Dashboards aus diesem Browser entfernen?"))return;
    try{
      await window.localData.clear();
      overview=null;await refreshMeta(true);await renderImport();
      message("Die eigenen Daten dieses Browsers wurden zurückgesetzt.");
    }catch(error){message(error.message);}
  });
  return {refresh};
})();
