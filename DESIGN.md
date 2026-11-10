# dsh-paperhub (`@yuigahamahawk/dsh-paperhub`) — build & integration contract

A persistent DSH bundle that adds a **left-sidebar entry** and a **full main-panel immersive reader +
library**. Paths in this document are relative to the plugin repository unless otherwise stated.
Package dir: `reader-plugin/`. Install with `plugin_manager install_bundle` (target = absolute package dir).

## Runtime facts (verified)

- Client plugin module is served from `package.json` `exports["./client"]` + `dsh.client`.
  It must be a classic script calling `window.__ModuleLoader__.load({ id, factory(require) })`.
  The factory may `require('react')` only (React 18). Everything else is the Cordis client `ctx`.
- Client `ctx` services available: `slots`, `locale`, `theme`, `layout` (`selectPanel`, `toggleSidebar`).
  Registration pattern: `ctx.slots.inject('<slot>', () => ctx.slots.register({ name:'<slot>', ...opts }, Component))`.
- Left entry: register `sidebar.panellist` with `id: 'reader'` + `label` + icon component (props `{size, active}`).
  The sidebar itself calls `selectPanel('reader')` when clicked.
- Main area: register `main` keyed slot with `key: 'reader'`; component receives no owner props.
- Host half (`index.js`) runs in the DSH Node host. Client<->host transport = authenticated Fetch routes
  registered with `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` where `path`
  is the exact pathname (e.g. `/api/dsh-reader/rpc`). Browser `fetch('/api/...')` carries the auth cookie.
  Static assets (pdf.js) are served by a plain `ctx.webServer.register({ kind:'prefix', path:'/dsh-reader-assets/' })`
  route (no auth, read-only whitelisted files, `Access-Control-Allow-Origin: *`).
- Desktop pages run on the privileged `dsh-app://app` scheme: ordinary same-origin `fetch()` reaches the
  host through the shell's forwarder, but Chromium refuses to load ES modules/workers from that custom
  scheme. `client-src/api.js#assetOrigin()` therefore uses `window.__DSH_TRANSPORT__.streamBaseUrl`
  (the host's real HTTP origin) for pdf.js module/worker/cmaps/fonts; RPC/uploads/files stay same-origin.
- Default AI = DSH model stack: `ctx.get('agentDefaultModel').currentSelection()` → `{provider, model}`,
  then `ctx.get('llm').stream(...)` — billed to the user's DeepSeek account. When the selected route is
  an API-key provider without a local key but a `*account*` route is registered, the host retries once on
  that account route (see `host/ai.js`). Custom providers = plain OpenAI-compatible HTTPS `fetch` on host.
- Boot safety: the client `apply()` wraps registration in try/catch and only reports diagnostics on
  failure — an activation exception previously crashed the whole desktop Web Boot (crash/restart loop).
- Theme tokens only for chrome: `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
  `--dsw-alias-bg-overlay`, `--dsw-alias-border-l1/l2`, `--dsw-alias-brand-primary`,
  `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-state-*`. Reader paper colors are
  CSS variables set by the app (`--dr-paper-bg`, `--dr-paper-fg`, `--dr-paper-muted`).
- All data lives host-side under `$DSH_HOME/dsh-paperhub/`. On upgrade, the store renames the
  legacy directory before initializing storage. If both directories exist, it reports the conflict
  and preserves both. The client fetches saved results on mount.

## Data dir layout

```
$DSH_HOME/dsh-paperhub/
  settings.json                 # { appearance, ai, zotero, ui }
  library.json                  # { version:1, docs: DocMeta[], folders: Folder[] }
  docs/<id>/original.<pdf|epub>
  docs/<id>/thumb.jpg           # optional cover
  docs/<id>/content.json        # parsed content (EPUB) / extract cache (PDF), see below
  docs/<id>/content.backup.json # one-generation backup taken before AI layout refinement
  docs/<id>/annotations.json    # Ann[] (style: 'highlight' | 'underline'; older records default to highlight)
  docs/<id>/aux.json            # { summary?, keypoints?, chat?: [...], translations? } AI output cache
  cache/translate/<xx>/<sha>.json
  cache/reflow/<xx>/<sha>.json  # per-page AI structure suggestions
  diagnostics.jsonl
```

## Shared shapes (JSON, camelCase)

```ts
Folder = { id: string; name: string; parentId: string|null; createdAt: number }

DocMeta = {
  id: string; format: 'pdf' | 'epub'; title: string; author?: string;
  size: number; addedAt: number; updatedAt: number; lastOpenedAt?: number;
  pageCount?: number; chapterCount?: number;
  cover?: boolean;                     // docs/<id>/thumb.jpg exists
  progress: { percent: number; locator?: string; label?: string };
  favorite: boolean; tags: string[];
  folderId: string | null;             // null = library root
  source: 'local' | 'zotero'; zoteroKey?: string;
  contentVersion?: number;
  stats?: { words?: number; translatedChars?: number; askCount?: number; tokens?: number };
}

// EPUB content.json  (client produces, host stores verbatim)
EpubContent = {
  kind: 'epub'; version: 1;
  meta: { title?: string; author?: string; language?: string; description?: string };
  toc: TocItem[];                       // { id, title, level, blockId? }
  blocks: Block[];                      // document-order reading blocks
  cover?: string;                       // data URL (small) or omitted, thumb served via /file
}
TocItem = { id: string; title: string; level: number; blockId?: string }

// PDF content.json (client produces while extracting, cached to avoid re-parsing)
PdfContent = {
  kind: 'pdf'; version: 1;
  engineVersion?: number;    // extraction heuristic version; older docs re-extract on open (no tokens)
  meta?: { title?: string; author?: string };
  pageCount: number;
  pages: { n: number; blocks: Block[] }[];   // reflowed text blocks per page
  toc?: TocItem[];
  figurePages?: number[];    // pages with a large interior text gap → likely figure/table
  regions?: { figures: number; formulas: number; pageFigures?: number };  // lazily rendered page-crop blocks
  aiRefined?: boolean; aiRefinedAt?: number; aiRefinedModel?: string | null;  // optional AI structure pass
  aiMathAt?: number; aiMathModel?: string | null; aiMathCount?: number;       // automatic AI LaTeX reconstruction
}

Block = {
  id: string;               // stable: 'e<epubbookpos>' for epub, 'p<page>b<i>' for pdf
  kind: 'paragraph' | 'heading' | 'quote' | 'list' | 'code' | 'image' | 'caption' | 'footnote' | 'artifact' | 'figure' | 'formula' | 'pageFigure';
  level?: number;           // heading level 1..3 in PDF reflow (document model caps at 3)
  html?: string;            // sanitized inline HTML (epub) — may contain <a>, <b>, <i>, <code>, <img ...>
  text: string;             // plain text used for translation/search/selection offsets
  page?: number;            // pdf
  rect?: { x: number; y: number; w: number; h: number };  // normalized page region for figure/formula crops
  latex?: string;           // AI-reconstructed display equation (rendered as MathML)
  image?: string;           // data URL for image blocks (epub) or rendered pdf image
}

Ann = {
  id: string; docId: string; color: 'yellow' | 'green' | 'blue' | 'pink' | 'purple';
  text: string; note?: string; createdAt: number; updatedAt: number;
  target:
    | { kind: 'reflow'; blockId: string; start: number; end: number }   // text offsets inside Block.text
    | { kind: 'pdf'; page: number; rects: { x: number; y: number; w: number; h: number }[] } // 0..1 normalized to page viewport
}

Settings = {
  appearance: {
    themeMode: 'system' | 'light' | 'dark'; paper: 'light' | 'sepia' | 'dark' | 'green';
    fontFamily: 'serif' | 'sans' | 'kai'; fontSize: number; lineHeight: number;
    paragraphSpacing: number; pageWidth: number; justify: boolean; hyphenate: boolean;
    showProgress: boolean; wideMode: boolean;
  };
  ai: {
    active: { chat: ModelRef; translate: ModelRef };     // ModelRef = { providerId:'dsh'|'<custom id>', model:string }
    targetLang: string;                                    // zh-CN | en | ja | ...
    translate: { mode:'bilingual'|'replace'; batchSize:number; auto:boolean; concurrency:number };
    chat: { contextMode:'doc'|'section'|'selection'; maxContextChars:number };
    providers: { id:string; name:string; kind:'openai'; baseURL:string; apiKey:string; models:string[] }[];
  };
  zotero: { enabled:boolean; apiKey:string; userId:string; local:boolean; autoSync:boolean; lastSyncAt?:number };
  ui: { lastDocId?: string; libraryView:'grid'|'list'; sidebarOpen:boolean; aiOpen:boolean; activeLeftTab:'toc'|'highlights'|'notes'|'search'; leftPanelWidth:number; rightPanelWidth:number; uiLang:'auto'|'en'|'zh-CN' };
}

ChatMsg = { id: string; role: 'user'|'assistant'; content: string; createdAt: number; quote?: string; model?: string }
```

## Host fetch routes

| path | method | body | response |
|---|---|---|---|
| `/api/dsh-reader/rpc` | POST | `{ method, params }` JSON | `{ ok:true, value }` or `{ ok:false, error:{ code, message } }` |
| `/api/dsh-reader/upload` | POST | raw bytes, query `?name=<urlenc>&format=pdf\|epub` | `{ ok:true, value:{ uploadId, name, size, format } }` |
| `/api/dsh-reader/file` | GET | query `?docId=&kind=original\|thumb` | bytes (`application/pdf` etc., 404 JSON otherwise) |
| `/api/dsh-reader/stream` | POST | `{ method, params }` JSON | `text/event-stream`; frames: `event: progress` `{type:'progress', value}`, `event: delta` `{type:'delta', text}`, `event: done` `{type:'done', value}`, `event: error` `{type:'error', code, message}` |
| `/dsh-reader-assets/*` | GET | — | pdf.js static assets (`pdf.mjs`, `pdf.worker.mjs`, `cmaps/*`, `standard_fonts/*`) |
| `/dsh-reader/health` | GET | — | `{ ok:true, version, documentCount, pdfjs, … }` (raw route, shell-verifiable) |

## RPC methods

- `ping` → `{ version, dataDir, model:{provider,model}, customProviders:[{id,name,models}] }`
- `library.list` → `{ docs: DocMeta[], folders: Folder[] }`
- `folders.list` → `{ folders }`; `folders.create {name,parentId?}` → `{ folder, folders }`; `folders.rename {id,name}` → `{ folder, folders }`;
  `folders.remove {id}` → `{ moved, folders, docs }` (documents return to the root); `folders.moveDoc {docId,folderId|null}` → `{ doc, folders }`
- `upload.commit` `{ uploadId, meta, content?, thumbDataUrl? }` → `{ doc: DocMeta }` (moves temp upload into docs/<id>/)
- `library.get` `{ id }` → `{ doc: DocMeta, content: EpubContent|PdfContent|null }`
- `library.update` `{ id, patch }` → `{ doc }` (shallow patch of DocMeta; progress is merged)
- `library.remove` `{ id }` → `{ ok:true }`
- `content.save` `{ id, content }` → `{ ok:true, contentVersion }`
- `content.backup` `{ id }` → `{ ok:true }` (copies content.json → content.backup.json before AI refinement)
- `content.restore` `{ id }` → `{ content }` (restores the pre-refinement backup; used by "undo AI layout")
- `annotations.list` `{ id }` → `{ annotations: Ann[] }`
- `annotations.save` `{ id, annotations }` → `{ ok:true }` (whole-list replace; client owned)
- `aux.get` `{ id, keys? }` → `{ aux }`
- `aux.set` `{ id, patch }` → `{ aux }` (deep merge; used for summary/keypoints/chat/token stats)
- `settings.get` → `{ settings }`
- `settings.set` `{ patch }` → `{ settings }` (deep merge; strips unknown)
- `ai.models` → `{ dsh:{available, provider, model, providers:[{id,name}]}, custom:[{id,name,models}], active, targetLang }`
- `ai.translate` `{ texts:string[], targetLang?, ref? }` → `{ translations:string[], cached:boolean[], usage:{chars,cachedChars} }` (host cache; `ref` = `{docId, blockIds}` for stats only)
- `ai.cache.stats` → `{ entries:number, bytes:number }`; `ai.cache.clear` → `{ ok:true }`
- `zotero.status` → `{ local:{available, library?}, web:{configured, userId?}, settings }`
- `zotero.collections` → `{ collections:[{key,name,count?}] }`
- `diag.report` `{ kind, payload }` → `{ ok:true }` (appends diagnostics.jsonl)

Stream methods (`/api/dsh-reader/stream`): `ai.chat` `{ messages:[{role,content}], system?, context?:{docId,title,text}, modelRef? }` →
delta frames of assistant text, final `{ text, model, usage }`. `zotero.sync` `{ collections?: string[] }` → progress frames, final summary.
`ai.summarize` `{ docId, scope:'doc'|'section', text, sectionTitle? }` → delta frames, final `{ text }` (cached in aux by client).
`ai.reflow` `{ docId, title, pages:[{n,blocks:[{id,kind,text}]}] }` → progress frames per page, final
`{ pages:[{n,headings:[{id,level}],drop:string[],explicit:boolean,cached}], model, cachedPages, totalPages }`.
Each page is one model call (concurrency 3, temperature 0) cached under `cache/reflow` by its exact block-payload hash
(`reflow-v3` prompt). Sanitization protects content: headings longer than 160 chars/30 words are rejected (a merged
heading+paragraph must never become a heading), captions/images/lists/quotes can never be dropped, per page ≤6 headings
and ≤8 drops. `explicit:true` means the model returned valid JSON, so an empty answer demotes that page's heuristic
headings; failed pages are left untouched. The client applies results incrementally (visible preview) with the pure
`client-src/refine.js#applyStructureRefinement` (unit-tested in `test/refine.test.mjs`) and persists once at the end.

`ai.formulas` remains available in the Host for older content, but the reader now renders every formula
as a full-width original-line image; auto reconstruction is disabled to save tokens. Each formula block
carries a normalized `rect` (`x: 0.04, w: 0.92`) sized to contain the whole equation and number.

Engine v11 extraction additionally forces a paragraph break after a section-heading-shaped line (so a heading never
swallows the first body sentence), caps heading text at 160 chars, merges the page-1 author/affiliation cluster and
footnote fragments, merges split display-equation fragments into one formula block, drops symbol-only artifacts, records
figure/formula page regions (normalized `rect`) and converts figure/table-heavy pages into a single `pageFigure` block
(whole-page image, including caption/labels). Reference/bibliography pages are always excluded from `pageFigure` so their
text stays searchable. It never renders
pages during extraction. Display equations are detected from short high-math-density paragraphs (requires `=`/Greek/math
operators, so chart tick labels and author lines are rejected); AI then reconstructs their LaTeX. The reflow viewer renders
each page at most once (serialized, cached) via pdf.js, crops every figure/formula on that page from the same canvas, and
falls back to an "open original page" button on failure. `figurePages` remains for the
highlighted per-page separator button.

## Client modules / write scopes (DO NOT edit files outside your scope)

Lead-owned (already written by Lead; ask Lead for changes):
`package.json`, `cordis.patch.yml`, `index.js`, `host/**`, `locale/**`, `icon.svg`, `build.mjs`,
`client-src/index.jsx`, `app.jsx`, `reader-shell.jsx`, `api.js`, `store.jsx`, `ui.jsx`, `icons.jsx`,
`styles.js`, `i18n.js`, `paragraph.jsx`, `util.js`, `diag.js`

Teammates add only their own files:
- `client-src/library.jsx` (LibraryView), `client-src/zotero.jsx` (ZoteroDialog)
- `client-src/epub.js`, `client-src/sanitize.js`, `client-src/content-epub.jsx`
- `client-src/pdf-engine.js`, `client-src/reflow.js`, `client-src/pdf-view.jsx`
- `client-src/ai-panel.jsx`, `client-src/translate.jsx`, `client-src/ai-settings.jsx`
- `client-src/annotations.jsx`, `client-src/annotations-panel.jsx`, `client-src/settings-appearance.jsx`

## App / store contracts

`client-src/api.js`: `createApi(ctx)` → API (all methods above):
`rpc(method, params)`, `upload(file: File|Blob, format, name)`, `fileUrl(docId, kind)`,
`stream(method, params, { onProgress, onDelta, onDone, onError, signal })`, `ping()`.

`client-src/store.jsx` exports:
- `AppProvider({ api, t, children })` (mounted by app.jsx)
- `useApp()` → `{ api, t, state, actions }` where `state = { ready, docs, doc, content, annotations, aux, settings, view, error, toast, diag }`
- `useSettings()` → `[settings, patchSettings(patch)]`
- `useToast()` → `{ toast(msg, kind?), dismiss(id) }`
- `useReader()` → reader-session context (provided by `ReaderShell`), shape:
  `{ doc, content, blocks: Block[], toc: TocItem[], activeBlockId, settings, t, api,
     annotations, addAnnotation(a), updateAnnotation(id, patch), removeAnnotation(id),
     activeAnnId, focusAnn(id),
     translate: { enabled, lang, status: 'off'|'on', get(blockId): TranslationEntry|undefined,
                  request(blockId): void, setEnabled(on), clear() },
     onSelect(args: { text, blockId, page?, rect } | null),
     askAbout(text, opts?), jumpTo(target), registerBlockEl(blockId, el|null),
     search(query): Promise<SearchHit[]>, searchQuery, setSearchQuery,
     scrollToBlock(blockId), moveBy(dir: 1|-1), openExportMenu(), openAi(), toggleLeftPanel(), toggleAiPanel() }`
- Translation is a service object created by `App` (`createTranslationService({api, settings, docId})`) and passed to `ReaderShell` via prop; `translate.jsx` (teammate D) implements it: `createTranslationService`, `TranslateBar`, `TranslationSettings` and the paragraph translation renderer.
- `client-src/ui.jsx` exports: `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Switch`, `Slider`,
  `Modal({open,onClose,title,children,footer,width})`, `Drawer`, `Tabs({tabs,value,onChange})`,
  `Tooltip`, `Menu`, `MenuItem`, `EmptyState`, `Spinner`, `ProgressRing`, `Badge`, `SegmentedControl`, `Kbd`.
- `client-src/icons.jsx` exports icon components: `IconLibrary, IconBook, IconSearch, IconSettings, IconTranslate,
  IconSpark, IconHighlighter, IconNote, IconList, IconChevronLeft/Right/Down, IconClose, IconPlus, IconUpload,
  IconFolder, IconCloud, IconSun, IconMoon, IconAuto, IconTextSize, IconPanelLeft, IconPanelRight, IconMore,
  IconDownload, IconTrash, IconEdit, IconCheck, IconCopy, IconBookmark, IconRefresh, IconZap, IconArrowLeft, IconFullscreen`.
- `client-src/paragraph.jsx` exports `ParagraphBlock({ block, className? })` — renders one reflow block with
  `.dr-block` wrapper, `data-block-id`, translation slot (reads `useReader().translate`), highlight-friendly text.
  PDF reflow and EPUB both use it.
- `client-src/i18n.js` exports `createT(ctx)` → `t(key, vars?)`; dictionaries zh/en. Key naming: `nav.*`,
  `library.*`, `reader.*`, `ai.*`, `ann.*`, `settings.*`, `zotero.*`, `common.*`. Teammates use `t('...')`
  from `useApp()`/`useReader()`; add keys to `i18n.js` only through Lead (send key list in your final report,
  or use `t('your.key')` with an English fallback passed as 2nd arg: `t('library.import', 'Import')` — the
  second argument is the fallback string, so untranslated keys never break the UI).

## Component contracts teammates must implement

- `library.jsx`: `export function LibraryView(props)` — props `{ onOpen(docId), onImport(), importing, settings, docs, actions }`
  rendered by App in `view==='library'`. Imports `zotero.jsx` dialog. Uses store/ui/icons/i18n.
- `content-epub.jsx`: `export function EpubContent({ content })` — reads everything else from `useReader()`;
  renders `ParagraphBlock` list + chapter anchors. Also `export function extractEpub(data: ArrayBuffer, opts?)`
  lives in `epub.js` → returns `{ content: EpubContent, thumb?: dataUrl }`.
- `pdf-view.jsx`: `export function PdfView({ content, mode, onLoadContent })` — needs raw bytes URL from
  `api.fileUrl(doc.id,'original')`; `loadPdfEngine(url)` from `pdf-engine.js`; `mode: 'reflow'|'original'`.
  Original mode = virtualized page canvases + text layer. Reports extracted reflow content through
  `onLoadContent({ content: PdfContent, thumb? })` when first extraction completes (App persists via content.save).
- `ai-panel.jsx` renders the assistant with its model selector, conversation and composer.
  Text selections, figures, tables and left-hand study cards can provide source context. The host streams replies and appends messages to the document's auxiliary data.
- `translate.jsx`: `createTranslationService({ api, settings, docId })` → object used by ReaderShell &
  ParagraphBlock: `{ enabled, lang, on:boolean, entries: Map, get(blockId), request(blockId), setEnabled(b),
  setLang(l), clear(), stats:{done,total,cached} }`; plus `export function TranslateControls()` rendered in reader top bar.
- `annotations.jsx`: `export function SelectionToolbar()` (floating toolbar when useReader().onSelect fired),
  `export function HighlightLayer()` (absolute overlay inside the scroll content container; uses
  registerBlockEl/rects and annotations), `export function createAnnotation(...)`.
- `annotations-panel.jsx`: `export function AnnotationsPanel({ tab })` for left sidebar tabs 批注/重点.
- `settings-appearance.jsx`: `export function AppearanceSettings()` for Settings dialog section.
- `ai-settings.jsx`: `export function AiSettings()` + `export function TranslationSettings()`.
- `zotero.jsx`: `export function ZoteroDialog({ open, onClose, onSynced })`.

## Build

`npm run build` in `reader-plugin` runs `build.mjs`: esbuild bundles `client-src/index.jsx` →
temporary cjs (`platform=browser`, `format=cjs`, `external:react`, `--jsx=automatic` NOT allowed since only
React.createElement is available: use classic JSX transform `--jsx=transform` which requires React in scope;
keep `import React from 'react'` in every .jsx file) then wraps into `client.js`:
```js
window.__ModuleLoader__.load({ id: '@yuigahamahawk/dsh-paperhub', factory(require) { ...cjs code... return module.exports; } });
```
Also copies pdf.js assets from `node_modules/pdfjs-dist/legacy/build/{pdf.mjs,pdf.worker.mjs}` plus
`cmaps/` and `standard_fonts/` into `assets/pdf/`. `index.js` serves them.

## Testing

- Host pure modules + wiring: `node test/host.test.mjs` (9 tests incl. AI account-route fallback and
  content-derived page/chapter counts) and `node test/plugin.test.mjs` (7 tests: real routes, upload/file,
  SSE error frame, static assets incl. traversal rejection, tool registration).
- Client build safety: `node tools/check.mjs` (syntax of every client-src file), then
  `node tools/mock-activate.cjs client.js` — executes the bundle factory and `apply()` against a mock DOM
  and fake Cordis ctx; this is the regression gate that prevents another web-boot crash loop.
- Live verification (desktop page, `dsh-app://app`):
  - Shell: `GET http://127.0.0.1:<port>/dsh-reader/health` reports version and aggregate health. Detailed diagnostics use the authenticated RPC or local logs.
  - `cordis_inspect_query` platform=client provider=`ReaderDiag`:
    `snapshot`, `env`, `fetchProbe`, `importProbe`, `selfTest`, `e2e` (`includeAi:true` costs a few tokens,
    validates the real DeepSeek-account chat + disk translation cache), `uiProbe` (renders the real
    ReaderApp off-screen, opens a temporary EPUB and PDF through the actual card click, asserts reader DOM).
  - Slot confirmation: `sidebar.panellist` id `reader`, `main` key `reader` both `active: true`.
  - Auto diagnostics: every client activation runs `self-test` + `render-test` and posts to
    `$DSH_HOME/dsh-paperhub/diagnostics.jsonl`.
- Host code reload during development without restarting the app: toggle the bundle off/on in Plugin
  Manager (`plugin_manager set_bundle`); client `client.js` changes are hot-swapped by Client HMR.
