import React from 'react'
import {useApp} from './store.jsx'
import {Row,Select,Input,Button,Divider} from './ui.jsx'
export function ParserSettings(){
  const {api,state,actions,t}=useApp(),config=state.settings.parser??{engine:'auto',tier:'standard',python:''}
  const [status,setStatus]=React.useState(null),[checking,setChecking]=React.useState(false),[python,setPython]=React.useState(config.python??'')
  const check=async()=>{setChecking(true);try{setStatus(await api.rpc('parser.status'))}catch(error){setStatus({available:false,message:error.message})}finally{setChecking(false)}}
  React.useEffect(()=>{check()},[])
  const patch=value=>actions.patchSettings({parser:value})
  return <>
    <Row label={t('parser.engine','Document parser')} description={t('parser.engineHint','Auto prefers an installed local MinerU. Without it, the existing visual model is used. A failed local parse keeps the original page; it never silently spends model tokens.')}>
      <Select value={config.engine} onChange={engine=>patch({engine})} options={[{value:'auto',label:t('parser.auto','Auto (prefer local)')},{value:'mineru',label:'MinerU · '+t('parser.local','Local')},{value:'vision',label:t('parser.vision','Visual model')}]}/>
    </Row>
    <Row label={t('parser.tier','MinerU quality')} description={t('parser.tierHint','Basic uses smaller OCR models; standard improves complex formulas and tables with more local compute.')}>
      <Select value={config.tier} onChange={tier=>patch({tier})} options={[{value:'basic',label:t('parser.basic','Basic')},{value:'standard',label:t('parser.standard','Standard')}]}/>
    </Row>
    <Row label={t('parser.python','MinerU Python (optional)')} description={t('parser.pythonHint','Leave blank to detect the reader’s local runtime. The selected environment needs MinerU 4.x and its models.')}>
      <Input value={python} onChange={event=>setPython(event.target.value)} onBlur={()=>patch({python:python.trim()})} placeholder="…/mineru/Scripts/python.exe"/>
    </Row>
    <Button size="sm" onClick={check} disabled={checking}>{checking?t('parser.checking','Checking…'):t('parser.check','Check local runtime')}</Button>
    {status?<p className={status.available?'dr-parser-status':'dr-parser-status is-error'}>{status.available?`MinerU ${status.version} · ${t('parser.ready','Local runtime ready; paid model calls are not used for this parser.')}`:status.message}</p>:null}
    <Divider/>
    <p className="dr-import-hint">{t('parser.scope','Changes apply to new or retried layouts. Completed reading results, highlights and translations are retained. No models are downloaded from this settings page.')}</p>
  </>
}
