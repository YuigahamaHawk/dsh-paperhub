const TAGS=new Set('math mrow mi mn mo ms mtext mspace msup msub msubsup mfrac msqrt mroot munder mover munderover mtable mtr mtd mstyle mpadded mphantom menclose semantics'.split(' '))
const ENUMS={display:['inline','block'],displaystyle:['true','false'],mathvariant:['normal','bold','italic','bold-italic','double-struck','script','bold-script','fraktur','bold-fraktur','sans-serif','bold-sans-serif','sans-serif-italic','sans-serif-bold-italic','monospace'],stretchy:['true','false'],fence:['true','false'],separator:['true','false'],accent:['true','false'],accentunder:['true','false'],movablelimits:['true','false'],form:['prefix','infix','postfix'],columnalign:['left','center','right'],rowalign:['top','bottom','center','baseline','axis']}
const NUMERIC=new Set(['scriptlevel','lspace','rspace','width','height','depth','linethickness','columnspacing','rowspacing'])
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))

/** MathML Core presentation only: no links, events, style, annotation XML or foreign namespaces. */
export function sanitizeMathElement(element){
  let size=0
  const text=[]
  function nodeHtml(node,depth=0){
    if(depth>64||size>100000)return ''
    if(node.nodeType===3||node.nodeType===4){const value=node.nodeValue??'';size+=value.length;text.push(value);return escape(value)}
    if(node.nodeType!==1)return ''
    const tag=String(node.localName??node.nodeName??'').toLowerCase().split(':').pop()
    if(!TAGS.has(tag))return ''
    let attrs=tag==='math'?' xmlns="http://www.w3.org/1998/Math/MathML"':''
    for(const attr of Array.from(node.attributes??[])){
      const name=attr.name.toLowerCase(),value=attr.value
      if(ENUMS[name]?.includes(value)||NUMERIC.has(name)&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|%)?$/.test(value))attrs+=` ${name}="${escape(value)}"`
    }
    return `<${tag}${attrs}>${Array.from(node.childNodes??[]).map(child=>nodeHtml(child,depth+1)).join('')}</${tag}>`
  }
  return {html:nodeHtml(element),text:text.join('')}
}
