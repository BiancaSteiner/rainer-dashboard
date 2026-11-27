import {BrowserData} from "./database.mjs";
import {analyse,exportAnalysis} from "./physics.mjs";

const databases=new Map(),controllers=new Map(),acks=new Map();
let mode="demo";
const scope=encodeURIComponent(new URL(".",self.location.href).pathname);
async function database(selectedMode=mode){
  if(!["own","demo"].includes(selectedMode))throw Error("Unbekannter Datensatz");
  if(!databases.has(selectedMode))databases.set(selectedMode,new BrowserData(scope,selectedMode));
  const db=await databases.get(selectedMode).open();
  if(selectedMode==="demo")await db.demo();
  return db;
}
async function shared(db,signal,operation){
  if(!navigator.locks)throw Error("Dieser Browser unterstützt die sichere lokale Datenverarbeitung nicht. Bitte einen aktuellen Browser verwenden.");
  return navigator.locks.request(db.name+"-write",{mode:"shared",signal},operation);
}
self.onmessage=async event=>{
  const {id,command,args={}}=event.data;
  if(command==="cancel"){controllers.get(id)?.abort();return;}
  if(command==="ack"){acks.get(id)?.();acks.delete(id);return;}
  const controller=new AbortController();controllers.set(id,controller);
  try{
    let result;
    if(command==="mode"){mode=args.mode;result=await (await database()).meta();}
    else{
      const db=await database(args.mode||mode),signal=controller.signal;
      if(command==="api"){
        const url=new URL(args.url,"https://local.invalid"),params=url.searchParams;
        if(url.pathname==="/api/meta")result=await db.meta();
        else if(url.pathname==="/api/imports")result=await db.history();
        else if(url.pathname==="/api/analysis")result=await shared(db,signal,()=>analyse(db,params,signal));
        else{
          const methods={"/api/overview":"overview","/api/comparison":"comparison","/api/events":"events","/api/spectrum":"spectrum"};
          const method=methods[url.pathname];
          if(!method)throw Error("Unbekannte Auswertung");
          result=await shared(db,signal,()=>db[method](params,signal));
        }
      }else if(command==="import"){
        result=await db.importFiles(args.files,args.options,progress=>self.postMessage({id,progress}));
      }else if(command==="clear"){
        await db.clear();result=await db.meta();
      }else if(command==="export"){
        const parameters=new URLSearchParams(args.params);
        const send=async chunk=>{
          signal.throwIfAborted();
          await new Promise(resolve=>{acks.set(id,resolve);self.postMessage({id,chunk});});
        };
        result=await shared(db,signal,()=>parameters.get("focus")==="rain"?
          exportAnalysis(db,parameters,send,signal):db.export(parameters,send,signal));
      }else throw Error("Unbekannte Aktion");
    }
    self.postMessage({id,result});
  }catch(error){
    self.postMessage({id,error:{name:error.name,message:error.message}});
  }finally{controllers.delete(id);}
};
