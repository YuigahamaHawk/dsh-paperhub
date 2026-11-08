// Crop after text ownership has been decided. Border ink means a stroke may
// have been cut by the approximate model rectangle: grow that side until the
// stroke ends, with a physical page-unit limit rather than a paper-specific
// offset. Independent prose/captions and other regions are masked first.
export function cropRegionCanvas(pageCanvas, initial, { masks = [], numberRect, fontSize = 10, pageWidth = 612, pageHeight = 792 } = {}) {
  const draw = rect => {
    const sx = Math.max(0, Math.floor(rect.x * pageCanvas.width)), sy = Math.max(0, Math.floor(rect.y * pageCanvas.height))
    const sw = Math.min(pageCanvas.width - sx, Math.max(1, Math.ceil(rect.w * pageCanvas.width))), sh = Math.min(pageCanvas.height - sy, Math.max(1, Math.ceil(rect.h * pageCanvas.height)))
    const crop = document.createElement('canvas')
    crop.width = Math.max(1, Math.min(2400, sw)); crop.height = Math.max(1, Math.round(sh * crop.width / sw))
    const context = crop.getContext('2d')
    if (!context) throw new Error('2D canvas unavailable')
    context.fillStyle = '#fff'; context.fillRect(0, 0, crop.width, crop.height)
    context.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height)
    const scale = crop.width / sw
    for (const r of [...masks, ...(numberRect ? [numberRect] : [])]) {
      const pad = r === numberRect ? 3 : 1.5
      context.fillRect((r.x * pageCanvas.width - sx) * scale - pad, (r.y * pageCanvas.height - sy) * scale - pad, r.w * pageCanvas.width * scale + pad * 2, r.h * pageCanvas.height * scale + pad * 2)
    }
    return { crop, context }
  }
  let rect = { ...initial }, frame
  const stepX = Math.max(2, fontSize * 0.6) / pageWidth, stepY = Math.max(2, fontSize * 0.6) / pageHeight
  for (let attempt = 0; attempt < 5; attempt++) {
    frame = draw(rect)
    const {crop, context} = frame
    const w=crop.width,h=crop.height,data=context.getImageData(0,0,w,h).data
    const counts=[0,0,0,0]
    for(let x=0;x<w;x++)for(let d=0;d<2;d++) {
      for(const [side,y] of [[0,d],[1,h-1-d]]) { const at=(y*w+x)*4;if(data[at]<235||data[at+1]<235||data[at+2]<235)counts[side]++ }
    }
    for(let y=0;y<h;y++)for(let d=0;d<2;d++) {
      for(const [side,x] of [[2,d],[3,w-1-d]]) { const at=(y*w+x)*4;if(data[at]<235||data[at+1]<235||data[at+2]<235)counts[side]++ }
    }
    const touch=counts.map(n=>n>2)
    if(!touch.some(Boolean)||attempt===4)break
    const right=rect.x+rect.w,bottom=rect.y+rect.h
    const x=Math.max(0,rect.x-(touch[2]?stepX:0)), y=Math.max(0,rect.y-(touch[0]?stepY:0))
    rect={x,y,w:Math.min(1,right+(touch[3]?stepX:0))-x,h:Math.min(1,bottom+(touch[1]?stepY:0))-y}
  }
  return frame
}
