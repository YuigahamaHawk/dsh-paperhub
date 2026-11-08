/** Latest snapshot per document, one write in flight. Failed writes remain recoverable locally. */
export function createPendingSaves({save,storage,prefix='dsh-reader:pending-annotations:',onError=()=>{},delay=400}){
  const records=new Map(),listeners=new Set();let revision=0
  const emit=()=>{revision++;for(const listener of listeners)listener()}
  const stash=(id,record)=>{try{if(!storage){record.durable=false;return}storage.setItem(prefix+id,JSON.stringify(record.value));record.durable=true}catch{record.durable=false}}
  const pump=id=>{
    const record=records.get(id);if(!record)return Promise.resolve();if(record.running)return record.running
    clearTimeout(record.timer);record.timer=null;const value=record.value,seq=record.seq
    record.running=Promise.resolve().then(()=>save(id,value)).then(()=>{
      if(record.seq===seq){records.delete(id);try{storage?.removeItem(prefix+id)}catch{}}
      record.error=null
    },error=>{record.error=error;onError(error,id)}).then(async()=>{
      record.running=null;emit();if(records.has(id)&&record.seq!==seq)await pump(id)
    })
    return record.running
  }
  const set=(id,value)=>{
    let record=records.get(id)
    if(!record){record={seq:0,value,running:false,timer:null,error:null};records.set(id,record)}
    record.value=value;record.seq++;record.error=null;stash(id,record);clearTimeout(record.timer);record.timer=setTimeout(()=>void pump(id),delay);emit()
  }
  return{
    set,
    peek:id=>records.get(id)?.value,
    flush(id){if(id)return pump(id);return Promise.all([...records.keys()].map(pump))},
    recover(ids){for(const id of ids)try{if(records.has(id))continue;const raw=storage?.getItem(prefix+id);if(raw){const value=JSON.parse(raw);if(Array.isArray(value))set(id,value)}}catch{}},
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
    getSnapshot:()=>revision,
    get size(){return records.size},
    has:id=>records.has(id),
    get hasErrors(){return [...records.values()].some(record=>record.error)},
    get allDurable(){return [...records.values()].every(record=>record.durable)},
  }
}
