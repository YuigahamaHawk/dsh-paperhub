// Shared reader stylesheet. Chrome uses host theme tokens only; the reading surface uses the
// paper variables set by <ReaderApp> (--dr-paper-*). Class prefix: dr-.
export const READER_CSS = `
.dr-root{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;overflow:hidden;isolation:isolate}
.dr-root *{box-sizing:border-box}
.dr-root button{font:inherit}
.dr-spin{animation:dr-spin 0.9s linear infinite}
@keyframes dr-spin{to{transform:rotate(360deg)}}
@keyframes dr-fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dr-pop-in{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
.dr-root ::-webkit-scrollbar{width:10px;height:10px}
.dr-root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 26%,transparent);border-radius:8px;border:2px solid transparent;background-clip:padding-box}
.dr-root ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 44%,transparent);border:2px solid transparent;background-clip:padding-box}
.dr-root ::-webkit-scrollbar-track{background:transparent}

/* ---------- app chrome ---------- */
.dr-header{flex:none;height:52px;display:flex;align-items:center;gap:10px;padding:0 12px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dr-header-brand{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary);padding-right:2px}
.dr-header-brand .dr-badge{margin-left:2px}
.dr-header-title{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dr-header-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dr-header-spacer{flex:1;min-width:8px}
.dr-header-actions{display:flex;align-items:center;gap:4px}
.dr-body{flex:1;min-height:0;display:flex}
.dr-rail{flex:none;width:52px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dr-rail .dr-iconbtn{width:36px;height:36px;border-radius:10px;color:var(--dsw-alias-label-secondary)}
.dr-rail .dr-iconbtn.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
.dr-rail-spacer{flex:1}
.dr-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative}
.dr-view{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden}

/* ---------- buttons / inputs ---------- */
.dr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;height:32px;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s,color .15s,opacity .15s;white-space:nowrap;min-width:0}
.dr-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 9%,var(--dsw-alias-bg-layer-1))}
.dr-btn:active{opacity:.85}
.dr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dr-btn:disabled{opacity:.45;cursor:not-allowed}
.dr-btn-sm{height:27px;padding:0 9px;font-size:12px;border-radius:7px}
.dr-btn-icononly{width:32px;padding:0}
.dr-btn-icononly.dr-btn-sm{width:27px}
.dr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dr-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,#000);}
.dr-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dr-btn-ghost:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.dr-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.dr-btn-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dr-btn-icon{display:inline-flex;flex:none}
.dr-btn-label{overflow:hidden;text-overflow:ellipsis}
.dr-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s;flex:none;padding:0}
.dr-iconbtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-primary)}
.dr-iconbtn.is-active{color:var(--dsw-alias-brand-primary)}
.dr-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dr-iconbtn-sm{width:26px;height:26px;border-radius:7px}
.dr-iconbtn-lg{width:38px;height:38px;border-radius:10px}
.dr-input{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0;color:var(--dsw-alias-label-primary)}
.dr-input:focus-within{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dr-input input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:inherit;font:inherit;height:100%}
.dr-input input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.dr-input-lead,.dr-input-trailing{display:inline-flex;color:var(--dsw-alias-label-secondary);flex:none}
.dr-textarea{width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:8px 10px;font:inherit;font-size:13px;resize:vertical;outline:none;line-height:1.55}
.dr-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dr-select{height:32px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 26px 0 9px;font:inherit;font-size:13px;cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary) 50%,transparent 50%);background-position:calc(100% - 14px) 14px,calc(100% - 9px) 14px;background-size:5px 5px,5px 5px;background-repeat:no-repeat;outline:none}
.dr-select:focus{border-color:var(--dsw-alias-brand-primary)}
.dr-switch-row{display:flex;align-items:center;justify-content:space-between;gap:14px;cursor:pointer;padding:5px 0}
.dr-switch-row.is-disabled{opacity:.5;cursor:not-allowed}
.dr-switch-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dr-switch-label{font-size:13px;color:var(--dsw-alias-label-primary)}
.dr-switch-desc{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.45}
.dr-switch{flex:none;width:36px;height:20px;border-radius:20px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;transition:background .18s,border-color .18s;padding:0}
.dr-switch.is-on{background:var(--dsw-alias-brand-primary);border-color:transparent}
.dr-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .18s}
.dr-switch.is-on .dr-switch-knob{transform:translateX(16px)}
.dr-slider-row{display:flex;flex-direction:column;gap:5px}
.dr-slider-head{display:flex;justify-content:space-between;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dr-slider-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dr-slider{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:4px;background:var(--dsw-alias-border-l1);outline:none}
.dr-slider::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-brand-primary);border:2px solid var(--dsw-alias-bg-base);cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.dr-segmented{display:inline-flex;align-items:center;background:var(--dsw-alias-bg-layer-2);border-radius:9px;padding:2px;gap:2px}
.dr-segment{display:inline-flex;align-items:center;gap:5px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:0 10px;height:27px;font-size:12.5px;cursor:pointer;white-space:nowrap}
.dr-segment:hover{color:var(--dsw-alias-label-primary)}
.dr-segment.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.dr-segment-icon{display:inline-flex}
.dr-kbd{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;border:1px solid var(--dsw-alias-border-l1);border-bottom-width:2px;border-radius:5px;padding:1px 5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.dr-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);line-height:18px;white-space:nowrap}
.dr-badge-brand{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
.dr-badge-success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}
.dr-badge-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dr-badge-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);color:var(--dsw-alias-state-error-primary)}
.dr-divider{position:relative;height:1px;background:var(--dsw-alias-border-l1);margin:10px 0}
.dr-divider-label{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--dsw-alias-bg-layer-1);padding:0 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dr-progress{height:4px;border-radius:4px;background:var(--dsw-alias-border-l1);overflow:hidden;width:100%}
.dr-progress-fill{height:100%;background:var(--dsw-alias-brand-primary);border-radius:4px;transition:width .3s}
.dr-progress-success .dr-progress-fill{background:var(--dsw-alias-state-success-primary)}
.dr-ring{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none}
.dr-ring-label{position:absolute;font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dr-loading{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;padding:18px}
.dr-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dr-row:last-child{border-bottom:none}
.dr-row-text{min-width:0}
.dr-row-label{font-size:13.5px;font-weight:500}
.dr-row-desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px;line-height:1.45}
.dr-row-control{flex:none;display:flex;align-items:center;gap:8px;max-width:52%}

/* ---------- tabs ---------- */
.dr-tabs{display:flex;align-items:center;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none}
.dr-tabs::-webkit-scrollbar{display:none}
.dr-tab{display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);height:32px;padding:0 10px;border-radius:7px;font-size:12.5px;cursor:pointer;white-space:nowrap;position:relative}
.dr-tab:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,transparent)}
.dr-tab.is-active{color:var(--dsw-alias-label-primary);font-weight:500}
.dr-tabs-underline{gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0}
.dr-tabs-underline .dr-tab{height:36px;border-radius:0;padding:0 10px}
.dr-tabs-underline .dr-tab.is-active:after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.dr-tab-badge{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent);color:var(--dsw-alias-label-secondary);border-radius:999px;font-size:10.5px;padding:0 5px;line-height:15px;min-width:15px;text-align:center}
.dr-tab-icon{display:inline-flex;opacity:.9}

/* ---------- popover / modal / drawer / toast ---------- */
.dr-popover{position:absolute;z-index:60;top:calc(100% + 6px);min-width:200px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:5px;animation:dr-pop-in .12s ease-out}
.dr-popover-end{right:0}
.dr-popover-start{left:0}
.dr-menuitem{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;padding:7px 9px;border-radius:7px;cursor:pointer;text-align:left}
.dr-menuitem:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent)}
.dr-menuitem:disabled{opacity:.45;cursor:default}
.dr-menuitem.is-danger{color:var(--dsw-alias-state-error-primary)}
.dr-menuitem-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);flex:none}
.dr-menuitem.is-danger .dr-menuitem-icon{color:inherit}
.dr-menuitem-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-menuitem-shortcut{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,monospace)}
.dr-modal-backdrop{position:fixed;inset:0;z-index:900;background:rgba(12,14,18,.42);display:flex;align-items:center;justify-content:center;padding:24px;animation:dr-fade-in .14s ease-out}
.dr-modal{max-width:calc(100vw - 40px);max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.32);overflow:hidden}
.dr-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:15px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dr-modal-title{font-size:15px;font-weight:600}
.dr-modal-body{padding:18px;overflow:auto;min-height:0}
.dr-modal-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1);flex:none;background:var(--dsw-alias-bg-layer-1)}
.dr-drawer-backdrop{position:fixed;inset:0;z-index:860;background:rgba(12,14,18,.32);animation:dr-fade-in .14s ease-out}
.dr-drawer{position:absolute;top:0;bottom:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 0 40px rgba(0,0,0,.22);animation:dr-fade-in .16s ease-out}
.dr-drawer-right{right:0;border-radius:14px 0 0 14px}
.dr-drawer-left{left:0;border-radius:0 14px 14px 0}
.dr-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dr-drawer-title{font-size:14px;font-weight:600}
.dr-drawer-body{flex:1;overflow:auto;padding:14px 16px;min-height:0}
.dr-toasts{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:1200;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;max-width:min(560px,86vw)}
.dr-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.22);padding:9px 12px;font-size:13px;animation:dr-fade-in .16s ease-out;max-width:100%}
.dr-toast-text{flex:1;min-width:0;overflow-wrap:anywhere}
.dr-toast-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dr-toast-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.dr-toast-close{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;padding:2px;border-radius:4px}
.dr-toast-close:hover{color:var(--dsw-alias-label-primary)}
.dr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:48px 24px;color:var(--dsw-alias-label-secondary);animation:dr-fade-in .2s ease-out}
.dr-empty-icon{display:flex;align-items:center;justify-content:center;width:66px;height:66px;border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 9%,transparent);color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dr-empty-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dr-empty-body{font-size:13px;max-width:380px;line-height:1.6}
.dr-empty-action{margin-top:10px}

/* ---------- library ---------- */
.dr-library{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;background:var(--dsw-alias-bg-base)}
.dr-folder-bar{flex:none;display:flex;align-items:center;gap:6px;padding:9px 30px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;scrollbar-width:none;background:var(--dsw-alias-bg-base)}
.dr-folder-bar::-webkit-scrollbar{display:none}
.dr-folder-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;cursor:pointer;white-space:nowrap;max-width:240px;flex:none}
.dr-folder-chip:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.dr-folder-chip.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent);color:var(--dsw-alias-label-primary);font-weight:500}
.dr-folder-chip svg{flex:none;opacity:.85}
.dr-folder-name{overflow:hidden;text-overflow:ellipsis}
.dr-folder-count{font-size:10.5px;line-height:16px;min-width:16px;text-align:center;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dr-folder-chip.is-active .dr-folder-count{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);color:var(--dsw-alias-brand-primary)}
.dr-folder-chip-wrap{display:inline-flex;align-items:center;gap:1px;flex:none}
.dr-folder-tools{display:inline-flex;align-items:center;gap:0}
.dr-folder-tools .dr-iconbtn{width:24px;height:24px;border-radius:6px}
@media (max-width:900px){.dr-folder-bar{padding:8px 16px}}
.dr-lib-scroll{flex:1;min-height:0;overflow:auto;padding:26px 30px 64px}
.dr-lib-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:18px}
.dr-lib-title{font-size:24px;font-weight:650;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
.dr-lib-sub{color:var(--dsw-alias-label-secondary);font-size:13px;margin-top:5px}
.dr-lib-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dr-lib-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:20px}
.dr-lib-toolbar .dr-input{width:300px;max-width:46vw}
.dr-lib-toolbar-spacer{flex:1}
.dr-lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:20px 18px}
.dr-card{position:relative;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;overflow:hidden;cursor:pointer;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;min-width:0;animation:dr-fade-in .18s ease-out}
.dr-card:hover{transform:translateY(-3px);box-shadow:0 14px 34px rgba(0,0,0,.14);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,var(--dsw-alias-border-l1))}
.dr-card-cover{position:relative;aspect-ratio:4/5.2;background:var(--dsw-alias-bg-layer-2);overflow:hidden;display:flex;align-items:center;justify-content:center}
.dr-card-cover img{width:100%;height:100%;object-fit:cover;display:block}
.dr-card-cover .dr-cover-art{position:absolute;inset:0}
.dr-card-format{position:absolute;top:8px;left:8px;z-index:2}
.dr-card-actions{position:absolute;top:6px;right:6px;display:flex;gap:3px;z-index:3;opacity:0;transform:translateY(-3px);transition:opacity .15s,transform .15s}
.dr-card:hover .dr-card-actions{opacity:1;transform:none}
.dr-card-actions .dr-iconbtn{background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 84%,transparent);backdrop-filter:blur(6px);width:26px;height:26px;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.dr-card-body{padding:10px 11px 12px;display:flex;flex-direction:column;gap:5px;min-width:0}
.dr-card-title{font-size:13.5px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.7em;overflow-wrap:anywhere}
.dr-card-author{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.3em}
.dr-card-foot{display:flex;align-items:center;gap:7px;margin-top:2px}
.dr-card-foot .dr-progress{flex:1}
.dr-card-progress-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dr-card-star{color:var(--dsw-alias-state-warn-primary);display:inline-flex;flex:none}
.dr-cover-art{display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
.dr-cover-art:after{content:"";position:absolute;inset:0;background:radial-gradient(120% 80% at 20% 10%,rgba(255,255,255,.28),transparent 60%)}
.dr-cover-art-inner{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:6px;color:#fff;text-shadow:0 1px 8px rgba(0,0,0,.22)}
.dr-cover-monogram{font-size:30px;font-weight:700;letter-spacing:.02em;line-height:1}
.dr-cover-format{font-size:10px;letter-spacing:.16em;opacity:.85;border:1px solid rgba(255,255,255,.5);border-radius:4px;padding:1px 6px}
.dr-lib-list{display:flex;flex-direction:column;gap:8px}
.dr-listrow{display:flex;align-items:center;gap:14px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.dr-listrow:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,var(--dsw-alias-border-l1));box-shadow:0 6px 18px rgba(0,0,0,.1)}
.dr-listrow-cover{width:42px;height:54px;border-radius:8px;overflow:hidden;flex:none;position:relative;background:var(--dsw-alias-bg-layer-2)}
.dr-listrow-main{flex:1;min-width:0}
.dr-listrow-title{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dr-listrow-meta{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dr-listrow-progress{width:150px;flex:none;display:flex;align-items:center;gap:8px}
.dr-lib-section-title{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:26px 0 12px}
.dr-drop-overlay{position:absolute;inset:12px;z-index:50;border:2px dashed var(--dsw-alias-brand-primary);border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-base));display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-brand-primary);font-size:15px;font-weight:600;pointer-events:none;animation:dr-fade-in .12s ease-out}
.dr-import-status{position:sticky;bottom:12px;z-index:20;margin:18px auto 0;max-width:560px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;box-shadow:0 10px 28px rgba(0,0,0,.2);display:flex;align-items:center;gap:10px;font-size:12.5px}
.dr-import-dialog{height:65vh;height:65dvh;min-height:min(420px,calc(100dvh - 48px))}
.dr-import-dialog .dr-modal-body{flex:1}
.dr-import-destination{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0;font-size:13px}
.dr-import-destination select{max-width:75%}
.dr-import-drop{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dr-import-drop p,.dr-import-hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;margin:8px 0}
.dr-import-files{list-style:none;padding:0;margin:12px 0;font-size:12px;line-height:1.6}
.dr-import-files li{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
.dr-import-selection{max-height:180px;overflow:auto}
.dr-import-selection li{display:flex;justify-content:space-between;gap:12px}
.dr-import-selection li>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-import-selection small{flex:none;color:var(--dsw-alias-label-secondary)}
.dr-import-urls{min-height:150px;width:100%;margin-top:2px}
.dr-import-job-title{display:flex;align-items:center;gap:8px}
.dr-import-path{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-import-job{padding:16px 0}
.dr-import-result{font-size:13px;line-height:1.7}
.dr-import-errors{padding:0;list-style:none;color:var(--dsw-alias-state-error-primary)}
.dr-import-errors li{display:flex;flex-direction:column;gap:3px;margin:12px 0;overflow-wrap:anywhere}

/* ---------- reader ---------- */
.dr-reader{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);position:relative}
.dr-reader-top{flex:none;min-height:48px;display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}
.dr-layout-status{flex:none;display:flex;align-items:center;gap:10px;padding:6px 14px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dr-layout-status.is-partial{color:var(--dsw-alias-state-error-primary)}
.dr-reader-doc{display:flex;flex-direction:column;min-width:0;margin:0 4px;cursor:pointer;padding:4px 6px;border-radius:7px}
.dr-reader-doc:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 9%,transparent)}
.dr-reader-doc-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw}
.dr-reader-doc-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw}
.dr-reader-stage{flex:1;min-height:0;display:flex;background:var(--dr-paper-bg);position:relative}
.dr-reader{container-type:inline-size}
.dr-reader-stage[data-compact]>.dr-leftpanel{position:absolute;inset:0 auto 0 0;z-index:30;box-shadow:12px 0 28px #0002}
.dr-reader-stage[data-compact]>.dr-aipanel{position:absolute;inset:0 0 0 auto;z-index:31;width:min(360px,94%);min-width:0;box-shadow:-12px 0 28px #0002}
.dr-reader-stage[data-compact]>.dr-panel-resizer,
.dr-reader-stage[data-compact]:has(>.dr-aipanel) .dr-reader-progress{display:none}
.dr-leftpanel{flex:none;width:320px;min-width:220px;max-width:560px;display:flex;flex-direction:column;border-right:1px solid var(--dr-paper-border);background:var(--dr-paper-bg);min-height:0;overflow:hidden}
.dr-leftpanel.is-collapsed{display:none}
.dr-leftpanel-tabs{padding:2px 6px 0;flex:none;border-bottom:1px solid var(--dr-paper-border)}
.dr-leftpanel-body{flex:1;min-height:0;overflow:auto;padding:10px 8px 24px}
.dr-toc{padding:4px 2px}
.dr-toc .dr-toc-item{display:flex;align-items:baseline;gap:8px;position:relative;width:100%;border:none;background:transparent;color:var(--dr-paper-fg);text-align:start;padding:5px 8px;padding-inline-start:calc(8px + var(--dr-toc-indent));border-radius:6px;font-size:12px;line-height:1.45;cursor:pointer}
.dr-toc-item:not(:disabled):hover{background:color-mix(in srgb,var(--dr-paper-fg) 7%,transparent)}
.dr-toc-item:disabled{cursor:default;color:var(--dr-paper-muted)}
.dr-toc-item.is-active{font-weight:650;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent)}
.dr-toc-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dr-toc-item[data-toc-level="1"]{font-size:14.5px;font-weight:650;padding-block:7px}
.dr-toc-item[data-toc-level="2"]{font-size:13px;font-weight:550}
.dr-toc-item:not([data-toc-level="1"])::before{content:"";position:absolute;inset-block:5px;inset-inline-start:var(--dr-toc-indent);border-inline-start:1px solid var(--dr-paper-border)}
.dr-reader-main{flex:1;min-width:0;min-height:0;display:flex;position:relative}
.dr-reader-scroll{flex:1;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;position:relative;scroll-behavior:smooth;background:var(--dr-paper-bg);container-type:inline-size}
@container (max-width:1100px){.dr-reader-scroll-inner.is-wide .dr-reader-content{max-width:min(calc(100% - 28px),920px)}}
@container (max-width:860px){.dr-reader-scroll-inner.is-wide .dr-reader-content{max-width:calc(100% - 20px)}}
.dr-reader-scroll-inner{position:relative;min-height:100%}
.dr-reader-content{max-width:min(var(--dr-page-width),100%);margin:0 auto;padding:22px 24px 96px;color:var(--dr-paper-fg);font-family:var(--dr-font-family);font-size:var(--dr-font-size);line-height:var(--dr-line-height);text-align:var(--dr-justify);hyphens:var(--dr-hyphenate);overflow-wrap:break-word;position:relative;transition:max-width .2s}
.dr-reader-scroll-inner.is-wide .dr-reader-content{max-width:calc(100% - 36px)}
.dr-region{margin:1.25em auto;max-width:100%;text-align:center;position:relative}
.dr-region-formula{margin:.9em auto}
.dr-region-img{display:block;max-width:100%;height:auto;margin:0 auto;border-radius:4px}
.dr-region-figure .dr-region-img{box-shadow:0 2px 10px rgba(0,0,0,.13);background:#fff;padding:2px}
.dr-region-formula .dr-region-img{max-height:none;width:auto;background:#fff;padding:0;box-shadow:none;border-radius:0}
.dr-region-placeholder{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;min-height:54px;border:1px dashed var(--dr-paper-border);border-radius:8px;color:var(--dr-paper-muted);font-size:12px;padding:8px 10px}
.dr-region-open{display:inline-flex;align-items:center;gap:3px;border:1px solid var(--dr-paper-border);background:color-mix(in srgb,var(--dr-paper-bg) 88%,transparent);color:var(--dr-paper-muted);border-radius:999px;font-size:10.5px;line-height:18px;padding:0 8px;cursor:pointer}
.dr-region-open:hover{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.dr-region-open.is-floating{position:absolute;right:5px;top:5px;opacity:0;transition:opacity .15s;width:22px;height:22px;padding:0;justify-content:center}
.dr-region:hover .dr-region-open.is-floating{opacity:1}
.dr-region-page{margin:1.4em auto}
.dr-media-open{display:block;width:100%;padding:0;border:0;background:transparent;cursor:zoom-in;color:inherit}
.dr-media-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:4px}
.dr-media-open img{margin:auto;max-width:100%;height:auto}
.dr-media-filter{width:100%;box-sizing:border-box;border:1px solid var(--dr-paper-border);border-radius:7px;padding:8px;background:transparent;color:var(--dr-paper-fg);font:inherit;font-size:12px;margin-bottom:10px}
.dr-media-item{display:flex;flex-direction:column;gap:5px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--dr-paper-border);background:transparent;color:var(--dr-paper-fg);padding:12px 6px;cursor:pointer;font-size:12px;line-height:1.6}
.dr-media-item:hover,.dr-media-item:focus-visible{background:color-mix(in srgb,var(--dr-paper-fg) 6%,transparent)}
.dr-media-item-meta{font-size:11px;color:var(--dr-paper-muted)}
.dr-media-card{margin:9px 0;border:1px solid var(--dr-paper-border);border-radius:9px;overflow:hidden;background:var(--dr-paper-bg);contain:layout}
.dr-media-card.is-selected,.dr-study-card.is-active{border-color:color-mix(in srgb,var(--dr-paper-fg) 35%,var(--dr-paper-border));background:color-mix(in srgb,var(--dr-paper-fg) 11%,var(--dr-paper-bg))}
.dr-media-card .dr-media-item{border:0;padding:9px;gap:7px}
.dr-media-thumbnail{display:flex;align-items:center;justify-content:center;width:100%;min-height:88px;max-height:180px;background:#fff;border-radius:5px;overflow:hidden;color:#71717a;font-size:11px}
.dr-media-thumbnail img{display:block;max-width:100%;width:auto;max-height:180px;height:auto;object-fit:contain}
.dr-media-thumbnail>span{padding:16px 10px;text-align:center}
.dr-media-card-actions{display:flex;justify-content:flex-end;padding:0 6px 5px}
.dr-media-card-actions .dr-btn{height:25px;font-size:11px}
.dr-study-map{padding:8px;color:var(--dr-paper-fg)}
.dr-study-actions{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 10px}
.dr-study-group{margin:5px 0 16px}
.dr-study-group h3{display:flex;align-items:center;gap:7px;font-size:12px;line-height:1.5;margin:7px 0;color:var(--dr-paper-muted)}
.dr-study-group h3>span{font-size:10px;font-weight:400;opacity:.8}
.dr-study-card{margin:7px 0;padding:10px;border:1px solid var(--dr-paper-border);border-radius:8px;line-height:1.65;font-size:12px;overflow-wrap:anywhere}
.dr-study-card:not(.is-stale):hover{border-color:color-mix(in srgb,var(--dr-paper-fg) 35%,var(--dr-paper-border))}
.dr-study-select{display:block;width:100%;padding:0;margin:0 0 6px;border:0;background:transparent;color:inherit;text-align:left;line-height:inherit;cursor:pointer}
.dr-study-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px;border-radius:2px}
.dr-study-card p{margin:0 0 6px}
.dr-study-card.is-stale{cursor:default;opacity:.7}
.dr-study-sources{display:flex;gap:5px;flex-wrap:wrap;margin:3px 0 6px}
.dr-study-sources button{font:inherit;font-size:10px;border:1px solid var(--dr-paper-border);border-radius:4px;background:transparent;color:var(--dsw-alias-brand-primary);padding:1px 5px;cursor:pointer}
.dr-study-card details{font-size:11px;color:var(--dr-paper-muted);cursor:auto}
.dr-study-card summary,.dr-study-legacy summary{cursor:pointer}
.dr-study-card blockquote{border-left:2px solid var(--dr-paper-border);margin:8px 0 0;padding-left:8px;white-space:pre-wrap;font-size:11px}
.dr-study-empty,.dr-study-receipt,.dr-study-legacy{font-size:11px;line-height:1.7;color:var(--dr-paper-muted);overflow-wrap:anywhere}
.dr-study-legacy p{white-space:pre-wrap}
.dr-study-error,.dr-parser-status.is-error{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dr-translation-engine{margin:2px 0 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.dr-translation-engine>.dr-field-hint{margin:0 0 5px}
.dr-translation-engine-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}
.dr-mind-hint{margin:0 0 18px;font-size:12px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dr-mind-tree{--dr-mind-line:color-mix(in srgb,var(--dsw-alias-label-secondary) 45%,transparent);--dr-mind-gap:14px;color:var(--dsw-alias-label-primary);padding:0 2px 4px}
.dr-mind-root{display:flex;align-items:center;gap:10px;max-width:min(560px,100%);width:fit-content;margin:0 auto;padding:10px 15px;border:1px solid var(--dr-mind-line);border-radius:10px;font-size:15px;line-height:1.45;background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere}
.dr-mind-root svg{flex:none;color:var(--dsw-alias-brand-primary)}
.dr-mind-branches,.dr-mind-branch ul{list-style:none;padding:0;margin:0}
.dr-mind-branches{position:relative;display:grid;grid-template-columns:repeat(var(--dr-mind-count),minmax(0,1fr));gap:var(--dr-mind-gap);padding-top:18px}
.dr-mind-branches::before{content:"";position:absolute;left:50%;top:0;height:18px;border-left:1px solid var(--dr-mind-line)}
.dr-mind-branch{--dr-mind-accent:#5681c8;position:relative;padding-top:14px;min-width:0}
.dr-mind-branch[data-study-category="objective"]{--dr-mind-accent:#397f8d}
.dr-mind-branch[data-study-category="method"]{--dr-mind-accent:#8961bc}
.dr-mind-branch[data-study-category="results"]{--dr-mind-accent:#488957}
.dr-mind-branch[data-study-category="limitations"]{--dr-mind-accent:#af7644}
.dr-mind-branch::before,.dr-mind-branch::after{content:"";position:absolute;top:0}
.dr-mind-branch::before{left:calc(var(--dr-mind-gap) / -2);right:calc(var(--dr-mind-gap) / -2);border-top:1px solid var(--dr-mind-line)}
.dr-mind-branch:first-child::before{left:50%}
.dr-mind-branch:last-child::before{right:50%}
.dr-mind-branch::after{left:50%;height:14px;border-left:1px solid var(--dr-mind-line)}
.dr-mind-branch h3{margin:0;padding:8px 9px;border:1px solid color-mix(in srgb,var(--dr-mind-accent) 46%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dr-mind-accent) 14%,var(--dsw-alias-bg-layer-1));font-size:13px;font-weight:650;text-align:center}
.dr-mind-branch ul{margin-inline-start:9px;border-inline-start:1px solid var(--dr-mind-line)}
.dr-mind-branch ul li{position:relative;padding:8px 0 0 10px}
.dr-mind-branch ul li::before{content:"";position:absolute;inset-inline-start:0;top:23px;width:10px;border-top:1px solid var(--dr-mind-line)}
.dr-mind-map .dr-mind-node{display:grid;gap:5px;width:100%;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;line-height:1.5;text-align:start;overflow-wrap:anywhere;cursor:pointer}
.dr-mind-node:hover,.dr-mind-node:focus-visible{border-color:var(--dr-mind-accent);outline:1px solid var(--dr-mind-accent);outline-offset:-1px}
.dr-mind-node span{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.dr-mind-node small{justify-self:start;color:var(--dsw-alias-label-secondary);font-size:10px}
@media(max-width:780px){
  .dr-mind-root{margin:0}
  .dr-mind-branches{display:flex;flex-direction:column;gap:10px;margin-inline-start:14px;padding:6px 0 0 14px;border-inline-start:1px solid var(--dr-mind-line)}
  .dr-mind-branches::before,.dr-mind-branch::after{display:none}
  .dr-mind-branch{padding-top:0}
  .dr-mind-branch::before,.dr-mind-branch:first-child::before,.dr-mind-branch:last-child::before{top:17px;left:-14px;right:auto;width:14px}
  .dr-mind-branch h3{text-align:start}
}
.dr-parser-status{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.dr-media-caption-source{display:block;white-space:pre-wrap}
.dr-media-caption-translation{display:block;margin-top:5px;color:var(--dsw-alias-label-secondary)}
.dr-media-item .dr-media-caption-source,.dr-media-item .dr-media-caption-translation{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.dr-media-backdrop{z-index:950}
.dr-media-dialog{width:1200px;max-width:100%;height:86vh;height:86dvh;max-height:100%;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px #0006}
.dr-media-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;gap:12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dr-media-head strong{font-size:13px}
.dr-media-zoom{display:flex;align-items:center;gap:8px}
.dr-media-zoom output{font-size:12px;min-width:44px;text-align:center}
.dr-media-stage{flex:1;min-height:80px;overflow:auto;touch-action:none;background:#e9e9ec;cursor:grab;overscroll-behavior:contain}
.dr-media-stage:active{cursor:grabbing}
.dr-media-plane{display:grid;place-items:center}
.dr-media-plane img{display:block;max-width:none;max-height:none;background:#fff;user-select:none}
.dr-media-caption{padding:12px 18px;max-height:24%;overflow:auto;font-size:12.5px;line-height:1.6;flex:none}
.dr-media-caption small{display:block;color:var(--dsw-alias-label-secondary);margin-top:6px}
.dr-media-caption .dr-btn{margin-top:8px}
@media(max-width:600px){.dr-media-backdrop{padding:8px}.dr-media-head{flex-wrap:wrap;gap:4px;padding:8px}.dr-media-zoom{gap:3px}.dr-media-caption{padding:8px 12px}}
.dr-region-page .dr-region-img{box-shadow:0 3px 16px rgba(0,0,0,.14);background:#fff;border-radius:5px}
.dr-formula-math{display:flex;justify-content:center;margin:1em 0;overflow-x:auto;overflow-y:hidden;padding:6px 4px;color:var(--dr-paper-fg)}
.dr-formula-math math{font-size:clamp(0.86rem,1.1vw,1.08rem);max-width:100%;display:inline-block}
.dr-formula-fallback{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.86em;white-space:pre-wrap;text-align:center;padding:.7em .8em;border-radius:6px;background:color-mix(in srgb,var(--dr-paper-fg) 5%,transparent);color:var(--dr-paper-muted);margin:.9em 0}
.dr-panel-resizer{flex:none;width:5px;margin:0 -2px;cursor:col-resize;position:relative;z-index:6;background:transparent;touch-action:none}
.dr-leftpanel-body{scrollbar-gutter:stable}
.dr-leftpanel-body::-webkit-scrollbar,.dr-reader-scroll::-webkit-scrollbar{width:9px;height:9px}
.dr-leftpanel-body::-webkit-scrollbar-thumb,.dr-reader-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dr-paper-fg) 22%,transparent);border-radius:99px;border:2px solid transparent;background-clip:padding-box}
.dr-leftpanel-body::-webkit-scrollbar-thumb:hover,.dr-reader-scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dr-paper-fg) 36%,transparent);background-clip:padding-box}
.dr-leftpanel-body::-webkit-scrollbar-track,.dr-reader-scroll::-webkit-scrollbar-track{background:transparent}
.dr-panel-resizer:after{content:"";position:absolute;top:0;bottom:0;left:2px;width:1px;background:var(--dsw-alias-border-l1);transition:background .15s,width .15s;border-radius:2px}
.dr-panel-resizer:hover:after,.dr-panel-resizer:active:after{left:1px;width:3px;background:var(--dsw-alias-brand-primary);opacity:.65}
.dr-ai-progress{font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-radius:999px;padding:1px 7px;line-height:16px;white-space:nowrap}
.dr-pdf-sep-btn{display:inline-flex;align-items:center;gap:3px;border:1px solid var(--dr-paper-border);background:transparent;color:var(--dr-paper-muted);border-radius:999px;font-size:10.5px;line-height:17px;padding:0 8px;cursor:pointer;flex:none}
.dr-pdf-sep-btn:hover{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.dr-pdf-sep-btn.is-figure{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent);font-weight:600}
.dr-block-footnote{font-size:.86em;color:var(--dr-paper-muted);line-height:1.6;margin-bottom:.8em}
.dr-block-image{margin:1.1em 0;text-align:center}
.dr-block-image img{max-width:100%;height:auto;border-radius:6px;display:block;margin:0 auto;box-shadow:0 1px 6px rgba(0,0,0,.08)}
.dr-block{position:relative;margin:0 0 var(--dr-paragraph-spacing);scroll-margin-top:60px}
.dr-block-text{white-space:pre-wrap}
.dr-block-heading{margin-top:1.5em;margin-bottom:.6em;font-weight:700;line-height:1.35;letter-spacing:-.01em}
.dr-block-heading:first-child{margin-top:0}
.dr-block-heading h1{font-size:1.62em;margin:0}
.dr-block-heading h2{font-size:1.4em;margin:0}
.dr-block-heading h3{font-size:1.22em;margin:0}
.dr-block-heading h4,.dr-block-heading h5,.dr-block-heading h6{font-size:1.06em;margin:0}
.dr-block-quote{padding:2px 0 2px 16px;border-left:3px solid color-mix(in srgb,var(--dr-paper-fg) 24%,transparent);color:var(--dr-paper-muted);font-style:italic}
.dr-block-list{padding-left:.2em;display:flex;flex-direction:column;gap:.32em}
.dr-block-list ul,.dr-block-list ol{margin:0;padding-left:1.35em;display:flex;flex-direction:column;gap:.34em}
.dr-block-list li{line-height:inherit}
.dr-block-list-item{position:relative}
.dr-block-code{background:color-mix(in srgb,var(--dr-paper-fg) 7%,transparent);border-radius:8px;padding:10px 13px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.86em;white-space:pre-wrap;line-height:1.55;overflow-x:auto}
.dr-block-image{margin:1.1em 0}
.dr-block-image img{max-width:100%;height:auto;border-radius:6px;display:block;margin:0 auto}
.dr-region-formula{width:100%;position:relative;display:flex;flex-direction:column;align-items:center}
.dr-region-formula .dr-region-img{max-width:calc(100% - 42px)}
.dr-formula-number{position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:.95em;color:var(--dr-paper-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.dr-block-caption{font-size:.85em;color:var(--dr-paper-muted);text-align:left;line-height:1.7}
.dr-block a{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.dr-block b,.dr-block strong{font-weight:650}
.dr-block sup{font-size:.7em}
.dr-block-translation{margin-top:.55em;padding-left:12px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 44%,transparent);color:var(--dr-paper-muted);font-size:.93em;line-height:1.68;text-align:inherit;font-family:inherit;white-space:pre-wrap}
.dr-block-translation.is-loading{display:flex;align-items:center;gap:7px;opacity:.7}
.dr-block-translation.is-error{color:var(--dsw-alias-state-error-primary);font-size:.86em;cursor:pointer;border-left-color:var(--dsw-alias-state-error-primary)}
.dr-block-translation .dr-tr-cached{opacity:.6;font-size:.8em;margin-left:6px;white-space:nowrap}
.dr-tr-retry{display:inline-flex;vertical-align:middle;margin-left:7px;padding:2px;border:0;border-radius:4px;background:transparent;color:inherit;opacity:.5;cursor:pointer}.dr-tr-retry:hover,.dr-tr-retry:focus-visible{opacity:1;background:var(--dr-paper-border)}
.dr-highlight-layer{position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:1}
.dr-highlight-rect{position:absolute;border-radius:2.5px;mix-blend-mode:multiply;opacity:.5;pointer-events:none;transition:opacity .15s}
.dr-highlight-rect:hover,.dr-highlight-rect.is-active{opacity:.85}
.dr-highlight-rect[data-color=yellow]{background:#ffe066}
.dr-highlight-rect[data-color=green]{background:#8ce99a}
.dr-highlight-rect[data-color=blue]{background:#8ecbff}
.dr-highlight-rect[data-color=pink]{background:#ffb3d1}
.dr-highlight-rect[data-color=purple]{background:#d0bfff}
.dr-leftpanel-tabs .dr-tab-label{font-size:10.5px;letter-spacing:0}
.dr-leftpanel-tabs .dr-tabs{gap:0;justify-content:space-between}
.dr-leftpanel-tabs .dr-tab{padding-left:4px;padding-right:4px;gap:3px;flex:none}
.dr-leftpanel{container-type:inline-size}
@container(max-width:255px){.dr-leftpanel-tabs .dr-tab-icon{display:none}.dr-leftpanel-tabs .dr-tab{padding-left:3px;padding-right:3px}.dr-leftpanel-tabs .dr-tab-label{font-size:10px}}
.dr-ann-quickbar{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:45;display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;border:1px solid var(--dr-paper-border);background:color-mix(in srgb,var(--dr-paper-bg) 94%,transparent);box-shadow:0 8px 30px rgba(0,0,0,.18);backdrop-filter:blur(8px);max-width:calc(100% - 32px);overflow-x:auto}
.dr-ann-quick-text{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dr-paper-muted);padding-right:4px}
.dr-ann-quickbar .dr-sel-color{width:20px;height:20px;flex:none}
.dr-highlight-rect[data-style=underline]{mix-blend-mode:normal;opacity:.95;border-radius:0}
.dr-highlight-rect[data-style=underline][data-color=yellow]{background:linear-gradient(to top,#d9a900 0 2px,transparent 2px)}
.dr-highlight-rect[data-style=underline][data-color=green]{background:linear-gradient(to top,#2e9e57 0 2px,transparent 2px)}
.dr-highlight-rect[data-style=underline][data-color=blue]{background:linear-gradient(to top,#2f74d0 0 2px,transparent 2px)}
.dr-highlight-rect[data-style=underline][data-color=pink]{background:linear-gradient(to top,#d9578f 0 2px,transparent 2px)}
.dr-highlight-rect[data-style=underline][data-color=purple]{background:linear-gradient(to top,#7b5bd6 0 2px,transparent 2px)}
.dr-reader-progress{position:absolute;right:16px;bottom:14px;z-index:5;display:flex;align-items:center;gap:8px;background:color-mix(in srgb,var(--dr-paper-bg) 88%,transparent);border:1px solid var(--dr-paper-border);border-radius:999px;padding:5px 11px;box-shadow:0 4px 14px rgba(0,0,0,.1);color:var(--dr-paper-muted);font-size:11px;font-variant-numeric:tabular-nums;backdrop-filter:blur(6px);pointer-events:none}
.dr-reader-progress .dr-progress{width:66px}
.dr-flash{animation:dr-flash 1.25s ease-out}
@keyframes dr-flash{0%{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);border-radius:4px}100%{background:transparent}}
.dr-reader-doc:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dr-ann-list{display:flex;flex-direction:column;gap:6px}
.dr-ann-item{border:none;background:transparent;text-align:left;padding:8px 9px;border-radius:8px;cursor:pointer;color:var(--dr-paper-fg);border-left:3px solid transparent;transition:background .14s}
.dr-ann-item:hover{background:color-mix(in srgb,var(--dr-paper-fg) 6%,transparent)}
.dr-ann-item.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.dr-ann-item[data-color=yellow]{border-left-color:#f2c94c}
.dr-ann-item[data-color=green]{border-left-color:#6fcf97}
.dr-ann-item[data-color=blue]{border-left-color:#56a8f5}
.dr-ann-item[data-color=pink]{border-left-color:#f28ab2}
.dr-ann-item[data-color=purple]{border-left-color:#a58bf0}
.dr-ann-quote{font-size:12.5px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;opacity:.92;margin-bottom:3px}
.dr-ann-note{font-size:12px;color:var(--dr-paper-muted);border-top:1px dashed color-mix(in srgb,var(--dr-paper-fg) 18%,transparent);padding-top:4px;margin-top:2px;white-space:pre-wrap;overflow-wrap:anywhere}
.dr-ann-meta{font-size:11px;color:var(--dr-paper-muted);margin-top:3px;display:flex;gap:8px;align-items:center}
.dr-side-empty{padding:26px 14px;text-align:center;color:var(--dr-paper-muted);font-size:12.5px;line-height:1.6}
.dr-side-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 9px 10px}
.dr-side-section-title{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dr-paper-muted)}
.dr-keypoint{display:flex;gap:9px;padding:8px 9px;border-radius:8px;cursor:pointer;color:var(--dr-paper-fg)}
.dr-keypoint:hover{background:color-mix(in srgb,var(--dr-paper-fg) 6%,transparent)}
.dr-keypoint-idx{flex:none;width:19px;height:19px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}
.dr-keypoint-text{font-size:12.8px;line-height:1.55;min-width:0}
.dr-summary{font-size:12.8px;line-height:1.65;color:var(--dr-paper-fg);padding:2px 9px 10px;white-space:pre-wrap;overflow-wrap:anywhere}
.dr-summary p{margin:0 0 .6em}
.dr-search-hit{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--dr-paper-fg);padding:8px 9px;border-radius:8px;cursor:pointer;font-size:12.5px;line-height:1.5}
.dr-search-hit:hover{background:color-mix(in srgb,var(--dr-paper-fg) 6%,transparent)}
.dr-search-hit mark{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:inherit;border-radius:2px;padding:0 1px}
.dr-search-hit-meta{display:block;font-size:11px;color:var(--dr-paper-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* selection toolbar */
.dr-selection-toolbar{position:fixed;z-index:800;display:flex;align-items:center;gap:3px;max-width:calc(100vw - 16px);overflow-x:auto;scrollbar-width:none;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.24);padding:4px;animation:dr-fade-in .1s ease-out}
.dr-sel-color{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;transition:transform .12s}
.dr-sel-color:hover{transform:scale(1.14)}
.dr-sel-color[data-color=yellow]{background:#ffe066}
.dr-sel-color[data-color=green]{background:#8ce99a}
.dr-sel-color[data-color=blue]{background:#8ecbff}
.dr-sel-color[data-color=pink]{background:#ffb3d1}
.dr-sel-color[data-color=purple]{background:#d0bfff}
.dr-sel-divider{width:1px;height:18px;background:var(--dsw-alias-border-l1);margin:0 3px}
.dr-note-editor{position:fixed;z-index:820;width:300px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 16px 44px rgba(0,0,0,.28);padding:12px;display:flex;flex-direction:column;gap:8px;animation:dr-fade-in .12s ease-out}
.dr-note-editor-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dr-note-editor-actions{display:flex;justify-content:flex-end;gap:6px}

/* ---------- AI panel ---------- */
.dr-aipanel{--dr-chat-accent:color-mix(in srgb,#247f8e 70%,var(--dsw-alias-label-primary));--dr-chat-ink:#1a6370;flex:none;width:var(--dr-ai-width,400px);min-width:272px;max-width:640px;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-height:0}
.dr-aipanel-head{flex:none;display:flex;align-items:center;gap:7px;padding:11px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dr-ai-mark{width:34px;height:34px;display:grid;place-items:center;flex:none;border:1px solid color-mix(in srgb,var(--dr-chat-accent) 35%,var(--dsw-alias-border-l1));border-radius:9px;color:var(--dr-chat-accent);background:color-mix(in srgb,var(--dr-chat-accent) 7%,var(--dsw-alias-bg-layer-1))}
.dr-ai-head-main{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.dr-ai-head-main strong{font-size:13px;font-weight:650;line-height:1.3}
.dr-ai-model,.dr-ai-scope{max-width:100%;min-width:0;height:24px;padding:0 18px 0 5px;font-size:11px;text-overflow:ellipsis;background-color:transparent;background-position:calc(100% - 9px) 10px,calc(100% - 6px) 10px;background-size:3px 3px;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dr-ai-model:hover,.dr-ai-scope:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.dr-ai-model option,.dr-ai-scope option{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dr-aipanel-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:14px 14px 18px;display:flex;flex-direction:column;gap:14px}
.dr-ai-empty{margin:auto 0;align-self:center;width:min(230px,100%);padding:12px 2px 20px;display:flex;flex-direction:column;align-items:flex-start;gap:9px;color:var(--dsw-alias-label-secondary)}
.dr-ai-empty>svg{color:var(--dr-chat-accent)}
.dr-ai-empty strong{color:var(--dsw-alias-label-primary);font-weight:650;font-size:15px}
.dr-ai-empty p{font-size:12px;line-height:1.55;margin:0 0 2px}
.dr-ai-empty .dr-btn{border:1px solid var(--dsw-alias-border-l1)}
.dr-chat-msg{display:flex;flex-direction:column;gap:5px;max-width:100%}
.dr-chat-msg.is-user{align-items:flex-end}
.dr-chat-bubble{font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary);max-width:100%;overflow-wrap:anywhere;white-space:pre-wrap}
.dr-chat-msg.is-user .dr-chat-bubble{padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dr-chat-accent) 11%,var(--dsw-alias-bg-layer-1))}
.dr-chat-bubble.dr-md{white-space:normal}
.dr-chat-quote{font-size:11.5px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dr-chat-accent);padding:1px 8px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.dr-chat-meta,.dr-ai-error,.dr-ai-thinking{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin:0;overflow-wrap:anywhere}
.dr-ai-error{color:var(--dsw-alias-state-error-primary)}
.dr-ai-thinking{display:flex;align-items:center;gap:7px}
.dr-ai-thinking>span{width:6px;height:6px;border-radius:50%;background:var(--dr-chat-accent);animation:dr-chat-pulse 1s infinite alternate}
@keyframes dr-chat-pulse{from{opacity:.35}to{opacity:1}}
.dr-ai-receipt{font-variant-numeric:tabular-nums;font-size:10.5px}
.dr-chat-composer{flex:none;display:flex;flex-direction:column;gap:7px;padding:8px 12px 12px}
.dr-ai-source{display:flex;align-items:center;gap:8px;padding:5px 6px 5px 9px;border:1px solid var(--dsw-alias-border-l1);border-left:2px solid var(--dr-chat-accent);border-radius:7px;color:var(--dr-chat-accent);background:color-mix(in srgb,var(--dr-chat-accent) 5%,var(--dsw-alias-bg-layer-1))}
.dr-ai-source>svg{flex:none}
.dr-ai-source-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dr-ai-source-copy strong,.dr-ai-source-copy span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dr-ai-source-copy strong{color:var(--dsw-alias-label-primary);font-size:11px}
.dr-ai-source-copy span{color:var(--dsw-alias-label-secondary);font-size:11px}
.dr-chat-field{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 42%,var(--dsw-alias-bg-layer-1));padding:5px}
.dr-chat-field:focus-within{border-color:var(--dr-chat-accent)}
.dr-chat-input{display:block;width:100%;min-height:48px;max-height:145px;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:6px;font:inherit;font-size:13px;line-height:1.5;outline:none;resize:vertical}
.dr-chat-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dr-chat-controls{display:flex;align-items:center;justify-content:space-between;gap:6px}
.dr-ai-source-tools{display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}
.dr-ai-source-tools .dr-btn{height:24px;color:var(--dsw-alias-label-primary)}
.dr-ai-source-tools span:not(.dr-btn-label){font-size:10px;color:var(--dsw-alias-label-secondary)}
.dr-chat-send{width:34px;height:34px;border-radius:7px;background:var(--dr-chat-ink);color:#fff;border:1px solid transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.dr-chat-send.is-stop{background:transparent;color:var(--dr-chat-accent);border-color:var(--dr-chat-accent)}
.dr-chat-send:enabled:hover{filter:brightness(1.13)}
.dr-chat-send:focus-visible{outline:2px solid var(--dr-chat-accent);outline-offset:1px}
.dr-chat-send:disabled{opacity:.4;cursor:default}
@media (prefers-reduced-motion:reduce){.dr-ai-thinking>span{animation:none}}
.dr-chip{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;font-size:11.5px;padding:3px 9px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.dr-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dr-md{font-size:13px;line-height:1.65;overflow-wrap:anywhere}
.dr-md h1,.dr-md h2,.dr-md h3,.dr-md h4{margin:.9em 0 .45em;line-height:1.35;font-weight:650}
.dr-md h1{font-size:1.3em}
.dr-md h2{font-size:1.16em}
.dr-md h3{font-size:1.04em}
.dr-md p{margin:0 0 .65em}
.dr-md ul,.dr-md ol{margin:.2em 0 .75em;padding-left:1.35em}
.dr-md li{margin:.18em 0}
.dr-md code{font-family:var(--ds-font-family-code,monospace);font-size:.9em;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);padding:1px 5px;border-radius:4px}
.dr-md pre{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);padding:9px 11px;border-radius:8px;overflow:auto;margin:.5em 0}
.dr-md pre code{background:none;padding:0}
.dr-md blockquote{margin:.5em 0;padding-left:11px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dr-md strong{font-weight:650}
.dr-md a{color:var(--dsw-alias-brand-primary)}

/* ---------- settings ---------- */
.dr-settings{flex:1;min-height:0;overflow:auto;padding:26px 30px 70px;background:var(--dsw-alias-bg-base)}
.dr-settings-inner{display:flex;gap:26px;max-width:980px;margin:0 auto;align-items:flex-start}
.dr-settings-nav{width:190px;flex:none;display:flex;flex-direction:column;gap:2px;position:sticky;top:0}
.dr-settings-navitem{display:flex;align-items:center;gap:8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-radius:8px;font-size:13px;cursor:pointer;text-align:left}
.dr-settings-navitem:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 9%,transparent);color:var(--dsw-alias-label-primary)}
.dr-settings-navitem.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-primary);font-weight:500}
.dr-settings-content{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:20px 22px;max-width:720px}
.dr-settings-h{font-size:16px;font-weight:650;margin:0 0 4px}
.dr-settings-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin:0 0 16px;line-height:1.5}
.dr-field{display:flex;flex-direction:column;gap:5px;margin-bottom:13px}
.dr-field-label{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dr-field-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.dr-field-row{display:flex;gap:8px;align-items:center}
.dr-swatch-row{display:flex;gap:8px;flex-wrap:wrap}
.dr-swatch{width:52px;height:34px;border-radius:8px;border:2px solid var(--dsw-alias-border-l1);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;transition:border-color .14s,transform .14s}
.dr-swatch:hover{transform:translateY(-1px)}
.dr-swatch.is-active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dr-provider-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.dr-provider-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.dr-provider-name{font-size:13px;font-weight:600}
.dr-provider-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dr-provider-grid .dr-field{margin-bottom:0}

/* ---------- zotero ---------- */
.dr-zotero-status{display:flex;flex-direction:column;gap:7px;margin:10px 0 16px}
.dr-zotero-status-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dr-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary)}
.dr-dot.is-ok{background:var(--dsw-alias-state-success-primary)}
.dr-dot.is-bad{background:var(--dsw-alias-state-error-primary)}
.dr-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.dr-zotero-progress{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);font-size:12.5px;display:flex;flex-direction:column;gap:8px;margin-top:12px}

/* ---------- responsive ---------- */
@media (max-width:1500px){
  .dr-reader-content{padding:18px 18px 84px}
  .dr-formula-math math{font-size:1rem}
  .dr-region-img{max-height:66vh}
  .dr-reader-doc-title,.dr-reader-doc-sub{max-width:28vw}
}
@media (max-width:1120px){
  .dr-leftpanel{width:244px}
  .dr-reader-content{padding:14px 12px 72px}
  .dr-formula-math{padding:4px 2px}
  .dr-formula-math math{font-size:.92rem}
  .dr-region-img{max-height:60vh}
  .dr-reader-doc-sub{display:none}
}
@media (max-width:900px){
  .dr-reader-content{padding:28px 20px 120px}
  .dr-lib-scroll{padding:18px 16px 60px}
  .dr-settings-inner{flex-direction:column}
  .dr-settings-nav{width:100%;flex-direction:row;overflow-x:auto;position:static}
  .dr-provider-grid{grid-template-columns:1fr}
  .dr-formula-math math{font-size:.86rem}
  .dr-region-img{max-height:54vh}
}
.dr-block-inline-actions{padding-right:42px;min-height:34px}
.dr-inline-tools{position:absolute;top:0;right:0;bottom:0;width:32px;display:flex;align-items:center;justify-content:center;color:var(--dr-paper-muted);font:12px/1.5 system-ui,sans-serif;user-select:none;z-index:3}
.dr-inline-logo{position:relative;display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:1px solid var(--dr-paper-border);border-radius:9px;color:inherit;background:var(--dr-paper-bg);cursor:pointer}
.dr-inline-logo:hover,.dr-inline-logo:focus-visible,.dr-inline-logo.is-done{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dr-paper-border))}
.dr-inline-logo:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dr-inline-logo.is-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dr-paper-border))}
.dr-inline-logo:disabled{opacity:.45;cursor:wait}
.dr-inline-done-badge{position:absolute;bottom:3px;right:3px;background:var(--dr-paper-bg);border-radius:50%}
.dr-inline-tooltip{position:absolute;right:calc(100% + 8px);top:50%;transform:translateY(-50%);width:max-content;min-width:150px;max-width:min(290px,calc(100vw - 80px));padding:8px 10px;border:1px solid var(--dr-paper-border);border-radius:8px;background:var(--dr-paper-bg);color:var(--dr-paper-fg);box-shadow:0 3px 15px #0002;text-align:left;opacity:0;visibility:hidden;pointer-events:none;z-index:10;overflow-wrap:anywhere}
.dr-inline-logo:hover+.dr-inline-tooltip,.dr-inline-logo:focus-visible+.dr-inline-tooltip{opacity:1;visibility:visible}
.dr-inline-tooltip[data-suppressed=true]{opacity:0!important;visibility:hidden!important}
.dr-inline-tooltip strong{font-weight:600}.dr-inline-tooltip-note{font-size:11px;color:var(--dr-paper-muted);margin-top:3px}
.dr-inline-error-detail{font-size:11px;color:var(--dsw-alias-state-error-primary);max-height:8em;overflow:hidden;overflow-wrap:anywhere;margin-top:4px}
.dr-inline-menu{z-index:100;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow-y:auto;padding:5px;border:1px solid var(--dr-paper-border);border-radius:9px;background:var(--dr-paper-bg);color:var(--dr-paper-fg);box-shadow:0 6px 26px #0003}
.dr-inline-menu-usage{font-size:11px;color:var(--dr-paper-muted);padding:6px 8px;border-bottom:1px solid var(--dr-paper-border);margin-bottom:4px}
.dr-inline-math{display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden;vertical-align:middle;scrollbar-width:thin;line-height:normal;padding:1px 0}
.dr-inline-math math{font-size:.98em;math-style:compact}
@media(pointer:coarse){.dr-block-inline-actions{padding-right:50px;min-height:42px}.dr-inline-tools{width:40px}.dr-inline-logo{width:40px;height:40px}}
.dr-workspace-bar{display:flex;align-items:center;gap:8px;flex:none;min-height:43px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dr-document-tabs{display:flex;gap:3px;align-items:stretch;overflow-x:auto;scrollbar-width:thin;flex:1;min-width:0;min-height:42px}
.dr-document-tab-wrap{display:flex;align-items:center;flex:0 0 auto;max-width:260px;min-width:150px;border-bottom:2px solid transparent;border-radius:7px 7px 0 0}
.dr-document-tab-wrap:hover,.dr-document-tab:hover{background:var(--dsw-alias-bg-layer-2)}
.dr-document-tab-wrap.is-active,.dr-library-tab.is-active{background:var(--dsw-alias-bg-layer-2);border-bottom:2px solid var(--dsw-alias-brand-primary)}
.dr-document-tab{font:inherit;font-size:12.5px;border:0;background:none;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:pointer;min-width:0;text-align:left;flex:1;white-space:nowrap}
.dr-document-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);font-weight:600}.dr-document-tab svg{flex:none}.dr-document-tab>span{overflow:hidden;text-overflow:ellipsis;max-width:185px}.dr-document-tab small{font-size:9px;font-weight:400;opacity:.65;flex:none}
.dr-library-tab{flex:none;border-bottom:2px solid transparent;position:sticky;left:0;background:var(--dsw-alias-bg-layer-1);z-index:2}
.dr-tab-close{display:flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;margin-right:3px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}.dr-tab-close:hover{background:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.dr-document-tab:focus-visible,.dr-tab-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dr-folder-chip.is-drop-target{outline:2px solid var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);transform:translateY(-1px)}
.dr-card[draggable=true],.dr-listrow[draggable=true]{cursor:grab}.dr-card[draggable=true]:active,.dr-listrow[draggable=true]:active{cursor:grabbing}
.dr-export-options{display:flex;flex-direction:column;gap:15px}.dr-export-options>label{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:13px}.dr-export-options>label select{max-width:75%;min-width:0}.dr-export-coverage{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-size:12.5px}.dr-export-coverage p{line-height:1.6;margin:8px 0}.dr-export-coverage>.dr-progress{margin-top:10px}
.dr-reader-scroll{overflow-anchor:none;scroll-behavior:auto}
.dr-save-status{position:relative;flex:0 0 32px;width:32px;height:32px}
.dr-save-announcement{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.dr-save-indicator{width:32px;height:32px;color:var(--dsw-alias-label-secondary)}
.dr-save-status[data-status=attention] .dr-save-indicator{color:#b77916;background:color-mix(in srgb,#edb742 12%,transparent)}
.dr-save-details{position:absolute;right:0;top:calc(100% + 8px);z-index:70;width:320px;max-width:calc(100vw - 64px);padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 28px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.dr-save-details strong{display:block;padding-right:20px;font-weight:600}
.dr-save-details p{margin:6px 0 10px;color:var(--dsw-alias-label-secondary)}
.dr-save-details .dr-save-dismiss{position:absolute;right:6px;top:6px;width:22px;height:22px}
.dr-settings-dialog{height:60vh;height:60dvh}
.dr-settings-dialog-body{flex:1;display:flex;overflow:hidden}
.dr-settings-dialog-body>.dr-settings-inner{flex:1;width:100%;min-width:0;min-height:0;align-items:stretch}
.dr-settings-dialog .dr-settings-nav{position:static;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.dr-settings-dialog .dr-settings-content{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
@media(max-width:700px){.dr-settings-dialog-body>.dr-settings-inner{gap:12px}.dr-settings-dialog .dr-settings-nav{overflow-y:hidden}.dr-settings-dialog .dr-settings-content{padding:16px}}
@container(max-width:600px){.dr-block-text,.dr-block-caption{text-align:left!important}}
@media(max-width:700px){.dr-workspace-bar{padding:0 6px;gap:4px}.dr-document-tab-wrap{max-width:200px;min-width:125px}.dr-document-tab>span{max-width:130px}.dr-document-tab{padding:8px 7px}.dr-document-tab small{display:none}}
`
