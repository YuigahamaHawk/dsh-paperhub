const encoder=new TextEncoder()
const table=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0})
export function crc(bytes){let n=0xffffffff;for(const b of bytes)n=table[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0}

/** Small dependency-free ZIP STORE writer. EPUB's mimetype entry must be first and uncompressed. */
export function zipStored(entries){
  const parts=[],central=[];let offset=0,size=0
  for(const [name,input] of entries){
    if(!name||name.startsWith('/')||name.includes('..')||name.includes('\\'))throw new Error('Invalid archive path')
    const filename=encoder.encode(name),data=typeof input==='string'?encoder.encode(input):input
    if(!(data instanceof Uint8Array)||data.length>0xffffffff||filename.length>65535)throw new Error('Archive entry too large')
    const sum=crc(data),local=new Uint8Array(30+filename.length),view=new DataView(local.buffer)
    view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x800,true);view.setUint16(12,0x21,true);view.setUint32(14,sum,true);view.setUint32(18,data.length,true);view.setUint32(22,data.length,true);view.setUint16(26,filename.length,true);local.set(filename,30)
    parts.push(local,data)
    const header=new Uint8Array(46+filename.length),cv=new DataView(header.buffer)
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint16(14,0x21,true);cv.setUint32(16,sum,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,filename.length,true);cv.setUint32(42,offset,true);header.set(filename,46)
    central.push(header);size+=header.length;offset+=local.length+data.length
  }
  if(entries.length>65535||offset+size>0xffffffff)throw new Error('Archive too large')
  const end=new Uint8Array(22),ev=new DataView(end.buffer)
  ev.setUint32(0,0x06054b50,true);ev.setUint16(8,entries.length,true);ev.setUint16(10,entries.length,true);ev.setUint32(12,size,true);ev.setUint32(16,offset,true)
  const output=new Uint8Array(offset+size+end.length);let at=0
  for(const part of [...parts,...central,end]){output.set(part,at);at+=part.length}
  return output
}
