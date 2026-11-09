import { applyVisionLayout, VISION_LAYOUT_VERSION } from './vision-layout.js'
import { renderVisionPages, renderLayoutInkPages } from './vision-render.js'
import { applyLayoutPlan, buildLayoutWindows, restoreParagraphFlow, LAYOUT_PLAN_VERSION } from './layout-plan.js'
import {mineruLayout,MINERU_LAYOUT_VERSION} from '../shared/mineru-layout.js'
import { constrainMediaCaptions } from './layout-captions.js'

export const hasCurrentVisualLayout=content=>content?.visionLayoutStatus==='complete'&&content.visionLayoutVersion===VISION_LAYOUT_VERSION&&(content.parser?.engine!=='mineru'||content.parser.version===MINERU_LAYOUT_VERSION)
export const hasFailedVisualLayout = content => content?.visionLayoutStatus === 'partial' && !!content.visionLayoutErrors?.length

export function keepFailedPagesOriginal(content,errors){
  const failed=new Map(errors.filter(error=>error.page).map(error=>[Number(error.page),error]))
  return {...content,pages:content.pages.map(page=>{
    const error=failed.get(Number(page.n))
    if(!error||page.vision?.version===VISION_LAYOUT_VERSION&&(!error.original||page.vision.mediaContract))return page
    const sourceBlocks=page.sourceBlocks??page.visionSourceBlocks??page.blocks??[]
    return {...page,sourceBlocks,flowBaseBlocks:undefined,vision:undefined,layoutFailed:true,layoutError:error.message,blocks:[{
      id:`p${page.n}unparsed`,kind:'pageFigure',page:page.n,layoutFailed:true,text:sourceBlocks.map(block=>block.text??'').join(' '),
      rect:{x:0,y:0,w:1,h:1},pageWidth:page.width,pageHeight:page.height,
    }]}
  })}
}

function finishParagraphs(content, plan, errors) {
  const base = keepFailedPagesOriginal(restoreParagraphFlow(content), errors)
  return applyLayoutPlan(base, plan, { inferContinuations: true, paragraphsOnly: true, failedPages: errors.map(error => error.page) }).content
}

// One owner and one serial writer for the document. Model calls may overlap;
// state publication never does. Every publish transforms the latest content.
export async function runVisualLayout({ api, doc, content, force = false, retryFailed = false, signal, onProgress = () => {}, renderPages = renderVisionPages, renderInkPages = renderLayoutInkPages, onContent = () => {} }) {
  let current = content
  const allPages = restoreParagraphFlow(content).pages ?? []
  const sources = new Map(allPages.map(page => [Number(page.n), page]))
  const failedNumbers = new Set((content.visionLayoutErrors ?? []).filter(error => error.page != null).map(error => Number(error.page)))
  const explicitPages = retryFailed && failedNumbers.size
  const pending = allPages.filter(page => force || failedNumbers.has(Number(page.n)) || (!explicitPages && page.vision?.version !== VISION_LAYOUT_VERSION)).map(page => page.n)
  const errors = [], active = new Set()
  let writer = Promise.resolve(), done = allPages.length - pending.length, cachedPages = 0
  let model = content.visionLayoutModel ?? '', regions = 0
  const check = () => { if (signal?.aborted) throw new Error('Layout cancelled') }
  const publish = transform => {
    writer = writer.then(async () => {
      check()
      current = transform(current)
      await api.rpc('content.save', { id: doc.id, content: current })
      onContent(current)
    })
    return writer
  }
  if (force || !content.visionLayoutStatus || content.parser?.engine==='mineru'&&content.parser.version!==MINERU_LAYOUT_VERSION) await api.rpc('content.backup', { id: doc.id })
  let parser
  try{parser=await api.rpc('parser.status')}catch{/* Older hosts retain their existing vision route. */}
  const recordedModel = content.visionLayoutModel ?? ''
  const priorEngine = /^MinerU\b/.test(recordedModel) ? 'mineru' : recordedModel ? 'vision' : content.parser?.engine ?? allPages.find(page => page.vision?.engine)?.vision.engine
  const local = retryFailed && priorEngine ? priorEngine === 'mineru' : parser?.engine==='mineru'||parser?.engine==='auto'&&parser?.available
  if(local){
    // A whole-document MinerU failure can leave every page of a previous layout readable.
    const previousErrors = content.visionLayoutErrors ?? []
    const retryWhole = retryFailed && previousErrors.some(error => error.page == null)
    // Caption checks run after a successful parse. Replay that evidence on
    // retry instead of repeating OCR for the same PDF and tier.
    const retryParser = retryFailed && !(previousErrors.length && previousErrors.every(error => error.original && error.page != null))
    onProgress({stage:'local-parser',done:0,total:allPages.length,engine:'mineru'})
    try{
      const pageNumbers = retryFailed && !retryWhole && pending.length && pending.length < allPages.length ? pending : undefined
      let recoveryProfile
      const parsed = await api.stream('parser.parse', {id:doc.id, force:force || retryParser, pageNumbers}, {
        onProgress: progress => {
          if (progress.stage === 'recovering') recoveryProfile = progress.profile
          onProgress({...progress, stage:'local-parser', done:0, total:allPages.length, engine:'mineru', recoveryProfile})
        },
      }, signal)
      check()
      const base = restoreParagraphFlow(current)
      const selected = pageNumbers ? { ...base, pages: allPages.filter(page => pageNumbers.includes(page.n)) } : base
      const layout=mineruLayout(selected,parsed.middle,{cached:parsed.cached,tier:parsed.tier})
      const targets = new Map(layout.pages.filter(page => !page.error && page.regions.some(region => region.kind === 'figure')).map(page => [page.n, page]))
      const checked = new Map()
      if (targets.size) {
        try {
          await renderInkPages({ api, docId: doc.id, pageNumbers: [...targets.keys()], signal, onPage: (n, ink) => {
            checked.set(n, constrainMediaCaptions(sources.get(n), targets.get(n), ink))
          } })
        } catch {
          check()
          // Rendering can fail on a locally parsed PDF. Keep its parser boxes.
        }
      }
      layout.pages = layout.pages.map(page => checked.get(page.n) ?? constrainMediaCaptions(sources.get(Number(page.n)), page))
      const failed=layout.pages.filter(page=>page.error).map(page=>({page:page.n,message:page.error,original:page.original}))
      const applied=applyVisionLayout(base,layout)
      const failedPages = new Set(failed.map(page => page.page))
      const completed = applied.content.pages.filter(page => page.vision?.version === VISION_LAYOUT_VERSION && !failedPages.has(page.n))
      const complete = completed.length === allPages.length
      await publish(()=>({...finishParagraphs(applied.content,null,failed),aiRefined:true,visionLayoutStatus:complete?'complete':'partial',visionLayoutVersion:complete?VISION_LAYOUT_VERSION:undefined,visionLayoutAt:Date.now(),visionLayoutModel:layout.model,visionLayoutErrors:failed,visionLayoutPages:completed.length,visionLayoutRegions:completed.reduce((sum,page)=>sum+(page.vision?.regions??0),0),parser:{engine:'mineru',version:MINERU_LAYOUT_VERSION,parserVersion:layout.parserVersion,tier:parsed.tier,elapsedMs:parsed.elapsedMs,cached:parsed.cached,local:true,recovery:parsed.recovery}}))
      onProgress({stage:'local-parser',done:allPages.length,total:allPages.length,engine:'mineru'})
      return {content:current,complete,errors:failed,cachedPages:parsed.cached?layout.pages.length:0,regions:applied.regions,model:layout.model}
    }catch(error){
      check()
      const failed=allPages.filter(page=>retryFailed&&!retryWhole?pending.includes(page.n):!page.vision).map(page=>({page:page.n,message:String(error.message??error)}))
      if(!failed.length)failed.push({page:null,message:String(error.message??error)})
      await publish(latest=>({...keepFailedPagesOriginal(latest,failed),visionLayoutStatus:'partial',visionLayoutErrors:failed,visionLayoutModel:'MinerU · local'}))
      throw error
    }
  }
  onProgress({ stage: 'vision', done, total: allPages.length, errors: 0 })
  let plan, planComplete = false
  try {
    await renderPages({ api, docId: doc.id, content, pageNumbers: pending, signal, captureInk: true, onPage: async (page, ink) => {
      check()
      while (active.size >= 2) await Promise.race(active)
      const task = (async () => {
        let result
        try {
          result = await api.stream('ai.visionLayout', { docId: doc.id, title: doc.title, pages: [page], force: force || retryFailed }, {}, signal)
          const answer = result?.pages?.find(value => Number(value.n) === Number(page.n))
          if (!answer || answer.error || !Array.isArray(answer.regions)) throw new Error(answer?.error ?? 'No visual result returned')
          model = result.model ?? model
          cachedPages += answer.cached ? 1 : 0
          const checked = constrainMediaCaptions(sources.get(Number(page.n)), answer, ink)
          if (checked.error) {
            errors.push({ page: page.n, message: checked.error, original: checked.original })
            return
          }
          await publish(latest => {
            const applied = applyVisionLayout(restoreParagraphFlow(latest), { ...result, pages: [checked] })
            regions += applied.regions
            return { ...applied.content, aiRefined: true, parser: undefined, visionLayoutStatus: 'partial' }
          })
        } catch (error) {
          if (signal?.aborted) throw error
          errors.push({ page: page.n, message: String(error?.message ?? error).slice(0, 240) })
        } finally {
          done++
          onProgress({ stage: 'vision', done, total: allPages.length, cachedPages, errors: errors.length, page: page.n })
        }
      })()
      active.add(task)
      task.finally(() => active.delete(task)).catch(() => {})
    } })
    await Promise.all(active)
    await writer
    check()
    // Cross-page paragraph decisions operate on the visual result, never on a
    // stale pre-vision snapshot. Overlapping windows cover every page boundary.
    const windows = buildLayoutWindows(current)
    if (windows.length && errors.length === 0 && (pending.length || force || current.layoutPlanVersion !== LAYOUT_PLAN_VERSION)) {
      onProgress({ stage: 'paragraphs', done: 0, total: windows.length, cachedPages, errors: 0 })
      plan = await api.stream('ai.layoutPlan', { docId: doc.id, title: doc.title, windows, force }, { onProgress: progress => onProgress({ ...progress, stage: 'paragraphs', cachedPages, errors: 0 }) }, signal)
      const covered = new Set(plan?.windows?.filter(window => !window.error).map(window => window.id))
      if (!windows.every(window => covered.has(window.id))) throw new Error('Paragraph structure is incomplete; retry the layout.')
      planComplete = true
    }
  } catch (error) {
    if (signal?.aborted) throw error
    errors.push({ page: null, message: String(error?.message ?? error).slice(0, 240) })
    await Promise.allSettled(active)
  }
  check()
  const complete = errors.length === 0 && current.pages.every(page => page.vision?.version === VISION_LAYOUT_VERSION)
  await publish(latest => ({
    ...finishParagraphs(latest,plan,errors), visionLayoutStatus: complete ? 'complete' : 'partial',
    layoutPlanAt: planComplete ? Date.now() : undefined,
    layoutPlanVersion: planComplete ? LAYOUT_PLAN_VERSION : undefined,
    layoutPlanModel: plan?.model,
    visionLayoutAt: complete ? Date.now() : undefined,
    visionLayoutVersion: complete ? VISION_LAYOUT_VERSION : undefined,
    visionLayoutModel: model, visionLayoutErrors: errors,
    visionLayoutPages: latest.pages.filter(page => page.vision?.version === VISION_LAYOUT_VERSION).length,
    visionLayoutRegions: latest.pages.reduce((sum, page) => sum + (page.vision?.regions ?? 0), 0),
  }))
  return { content: current, complete, errors, cachedPages, regions, model }
}
