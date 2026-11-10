// Host half of dsh-paperhub.
//
// Responsibilities:
//  - owns the reader data directory ($DSH_HOME/dsh-paperhub) and all persistence
//  - exposes its capabilities to the browser half through authenticated Fetch routes
//    (ctx.connection.fetch.register) mounted under /api/dsh-reader/*
//  - serves pdf.js static assets through a plain read-only prefix route
//  - performs every model call host-side: DSH's configured default model (DeepSeek account)
//    or a user-provided OpenAI-compatible endpoint
//  - caches AI output on disk so re-opening a document never pays twice
//  - syncs Zotero items/attachments into the library
//  - registers agent tools so the same operations are available to the assistant
import { applyReaderHost } from './host/plugin.js'

/** Client<->host RPC and static assets require the Web carrier and its exact-route registry. */
export const inject = ['webServer', 'connection']

/** Register every host capability; resource cleanup is owned by the plugin fiber. */
export function apply(ctx) {
  applyReaderHost(ctx)
}
