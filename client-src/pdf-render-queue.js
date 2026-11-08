export const PDF_PAGE_TIMEOUT = 'pdf-page-timeout'

/** Serialize PDF draws and only start the watchdog once the page can run. */
export function createPdfRenderQueue(timeoutMs = 20000) {
  let tail = Promise.resolve()
  return render => {
    const job = tail.then(async () => {
      const controller = new AbortController()
      let timer
      try {
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('PDF page render timed out')
            error.code = PDF_PAGE_TIMEOUT
            reject(error)
            controller.abort()
          }, timeoutMs)
        })
        return await Promise.race([render(controller.signal), deadline])
      } finally {
        clearTimeout(timer)
      }
    })
    tail = job.catch(() => undefined)
    return job
  }
}
