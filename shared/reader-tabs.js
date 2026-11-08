export function normalizeTabs(ids, allowed) {
  const valid = allowed ? new Set(allowed) : null
  return [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id && id.length <= 100 && (!valid || valid.has(id))))].slice(0, 32)
}

export function closeTab(ids, id, activeId) {
  const index = ids.indexOf(id), tabs = ids.filter(value => value !== id)
  return { tabs, nextId: activeId !== id ? activeId : tabs[Math.min(index, tabs.length - 1)] ?? null }
}

export function moveTab(ids, id, beforeId) {
  if (id === beforeId || !ids.includes(id) || !ids.includes(beforeId)) return ids
  const tabs = ids.filter(value => value !== id)
  tabs.splice(tabs.indexOf(beforeId), 0, id)
  return tabs
}
