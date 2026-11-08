/** Startup shell checks track both the current workspace and legacy reader chrome. */
export function shellRenderHealth(html){
  const source=String(html??''),hasRoot=source.includes('dr-root')
  const hasHeader=source.includes('dr-workspace-bar')||source.includes('dr-header')||source.includes('dr-reader-top')
  return{ok:source.length>800&&hasRoot&&hasHeader,hasRoot,hasHeader,hasLibrary:source.includes('dr-library'),hasCards:source.includes('dr-card')||source.includes('dr-listrow'),hasEmptyState:source.includes('dr-empty')}
}
