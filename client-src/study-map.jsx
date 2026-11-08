import React from 'react'
import {useApp,useReader} from './store.jsx'
import {Button, Modal} from './ui.jsx'
import {IconBook, IconChat, IconSpark} from './icons.jsx'
import {STUDY_CATEGORIES,validStudyEvidence} from '../shared/study-map.js'

export function StudyMapPanel(){
  const {t}=useApp(),reader=useReader(),map=reader.aux?.keypoints
  const [mindOpen,setMindOpen]=React.useState(false)
  const mindTrigger=React.useRef(null)
  const structured=map?.version===1&&Array.isArray(map.groups)
  const blocks=reader.blocks??(reader.content?.pages??[]).flatMap(page=>page.blocks??[]),byId=new Map(blocks.map(block=>[block.id,block]))
  const labels={background:t('study.background','Research background'),objective:t('study.objective','Research objectives'),method:t('study.method','Core content'),results:t('study.results','Experimental results'),limitations:t('study.limitations','Limitations & scope')}
  const groups=structured ? STUDY_CATEGORIES.map(id=>({
    id,
    points:(map.groups.find(group=>group.id===id)?.points??[]).map(point=>({point,valid:validStudyEvidence(point.evidence,byId)})),
  })) : []
  const branches=groups.map(({id,points})=>({id,points:points.filter(item=>item.valid).map(item=>item.point)})).filter(branch=>branch.points.length)
  const choose=(id,point,evidence=point.evidence[0])=>{
    const quotes=[evidence,...point.evidence.filter(item=>item!==evidence)]
    reader.selectAskSource({
      kind:'point',id:point.id,title:labels[id],page:evidence.page,blockId:evidence.blockId,
      text:[point.text,...quotes.map(item=>item.page?'[P'+item.page+'] '+item.quote:item.quote)].join('\n\n'),
    })
    reader.jumpTo({blockId:evidence.blockId})
  }
  const closeMindMap=()=>{
    setMindOpen(false)
    mindTrigger.current?.focus()
  }
  return <div className="dr-study-map">
    <div className="dr-study-actions">
      <Button size="sm" variant={structured?'default':'primary'} icon={<IconSpark size={14}/>} disabled={reader.summaryGenerating} onClick={()=>reader.generateSummary('studyMap')}>{reader.summaryGenerating?t('reader.generating','AI is reading the document…'):structured?t('reader.regenerate','Regenerate'):t('study.generate','Organize key points')}</Button>
      {reader.summaryGenerating?<Button size="sm" variant="ghost" onClick={reader.cancelSummary}>{t('common.cancel','Cancel')}</Button>:null}
      {branches.length?<Button size="sm" aria-haspopup="dialog" onClick={event=>{mindTrigger.current=event.currentTarget;setMindOpen(true)}}>{t('study.mindMap','Mind map')}</Button>:null}
    </div>
    {reader.summaryError?<p className="dr-study-error">{reader.summaryError}</p>:null}
    {structured&&map.rejected?.length?<p className="dr-study-empty">{t('study.rejected','Excluded {count} candidates that failed evidence checks; the cards below passed.',{count:map.rejected.length})}</p>:null}
    {!structured?<p className="dr-study-empty">{t('study.hint','Generate categorized cards with verified source passages. Click a card to return to its evidence.')}</p>:null}
    {!structured&&typeof reader.aux?.summary==='string'&&reader.aux.summary?<details className="dr-study-legacy"><summary>{t('study.legacy','Previous summary')}</summary><p>{reader.aux.summary}</p></details>:null}
    {groups.map(({id,points})=>{
      return <section key={id} className="dr-study-group" data-study-category={id}>
        <h3>{labels[id]}<span>{points.length}</span></h3>
        {!points.length?<p className="dr-study-empty">{t('study.noEvidence','No explicit evidence was identified.')}</p>:null}
        {points.map(({point,valid})=>{
          const selected = valid && reader.askSource?.kind === 'point' && reader.askSource.id === point.id
          return <article key={point.id} className={'dr-study-card'+(selected?' is-active':'')+(!valid?' is-stale':'')}>
            {valid
              ? <button className="dr-study-select" type="button" aria-pressed={selected} onClick={() => choose(id,point)}>{point.text}</button>
              : <><p>{point.text}</p><small>{t('study.stale','Source changed; regenerate these cards.')}</small></>}
            {valid?<div className="dr-study-sources">{point.evidence.map((source,i)=><button key={i} type="button" onClick={()=>choose(id,point,source)}>{source.page?`P${source.page}`:t('study.source','Source')}</button>)}</div>:null}
            <details><summary>{t('study.evidence','Verify evidence')}</summary>{(point.evidence??[]).map((source,i)=><blockquote key={i}>{source.quote}</blockquote>)}</details>
            {selected?<Button size="sm" variant="ghost" icon={<IconChat size={13}/>} onClick={()=>reader.askAbout(reader.askSource)}>{t('ai.askSource','Ask about this')}</Button>:null}
          </article>
        })}
      </section>
    })}
    <Modal open={mindOpen&&branches.length>0} onClose={closeMindMap} width={1100} className="dr-mind-map" title={t('study.mindMap','Mind map')}>
      <p className="dr-mind-hint">{t('study.mindHint','Select any point to jump to its source in the document.')}</p>
      <div className="dr-mind-tree">
        <div className="dr-mind-root"><IconBook size={17}/><strong>{reader.content?.meta?.title||reader.doc?.title||t('study.mindDocument','Current document')}</strong></div>
        <ul className="dr-mind-branches" style={{'--dr-mind-count':branches.length}}>
          {branches.map(({id,points},branchIndex)=><li key={id} className="dr-mind-branch" data-study-category={id}>
            <h3>{labels[id]}</h3>
            <ul>{points.map((point,pointIndex)=><li key={point.id}>
              <button type="button" className="dr-mind-node" title={point.text} autoFocus={branchIndex===0&&pointIndex===0}
                onClick={()=>{closeMindMap();choose(id,point)}}>
                <span>{point.text}</span>
                <small>{point.evidence[0].page?'P'+point.evidence[0].page:t('study.source','Source')}</small>
              </button>
            </li>)}</ul>
          </li>)}
        </ul>
      </div>
    </Modal>
    {structured?<p className="dr-study-receipt">{map.model??''}{map.cached?' · '+t('inline.cached','Cached'):''}{Number.isFinite(map.usage?.totalTokens)?` · ${map.usage.totalTokens.toLocaleString()} tokens`:''}</p>:null}
  </div>
}
