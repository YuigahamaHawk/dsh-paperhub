// Minimal LaTeX -> MathML converter for AI-reconstructed display equations.
//
// The reader never injects raw LaTeX/HTML: the converter only emits a small whitelist of MathML
// elements and escapes every text fragment, so AI output cannot introduce markup. Unknown commands
// degrade to text instead of failing the formula.
const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}
const SYMBOLS = {
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈',
  sim: '∼', simeq: '≃', propto: '∝', infty: '∞', sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', partial: '∂', nabla: '∇',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', mapsto: '↦',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨', oplus: '⊕', otimes: '⊗', perp: '⊥', parallel: '∥',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱', prime: '′', degree: '°', angle: '∠', triangle: '△',
  log: 'log', ln: 'ln', exp: 'exp', max: 'max', min: 'min', arg: 'arg', det: 'det', lim: 'lim', sup: 'sup', inf: 'inf',
  sin: 'sin', cos: 'cos', tan: 'tan', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', mod: 'mod', bmod: 'mod',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', backslash: '\\', '%': '%', '#': '#',
}
const FUNCTIONS = new Set(['log', 'ln', 'exp', 'max', 'min', 'arg', 'det', 'lim', 'sup', 'inf', 'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'mod', 'bmod'])
const OPERATORS = new Set(['+', '-', '=', '<', '>', '/', '|', '(', ')', '[', ']', ',', ';', ':', '!', '?', '*', '&'])
const SPACING = new Set([',', ';', ':', '!', 'quad', 'qquad', ' '])
const ACCENTS = { dot: '˙', ddot: '¨', hat: '^', bar: '¯', vec: '→', tilde: '~', overline: '‾', underline: '_' }

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function stripDelimiters(source) {
  let value = String(source ?? '').trim()
  value = value.replace(/^\$\$?/, '').replace(/\$\$?$/, '')
  value = value.replace(/^\\\[/, '').replace(/\\\]$/, '')
  value = value.replace(/^\\\(/, '').replace(/\\\)$/, '')
  value = value.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '')
  return value
}

class LatexParser {
  constructor(source) {
    this.source = stripDelimiters(source)
    this.index = 0
  }

  eof() {
    return this.index >= this.source.length
  }

  peek() {
    return this.source[this.index] ?? ''
  }

  skipSpaces() {
    while (!this.eof() && /\s/.test(this.peek())) this.index++
  }

  readCommandName() {
    let name = ''
    while (!this.eof() && /[A-Za-z]/.test(this.peek())) {
      name += this.peek()
      this.index++
    }
    return name
  }

  /** Read a {...} group as MathML children (the braces are consumed). */
  readGroup() {
    this.skipSpaces()
    if (this.peek() === '{') {
      this.index++
      const node = this.parseExpression('}')
      if (this.peek() === '}') this.index++
      return node
    }
    return this.parseAtom()
  }

  readRawGroup() {
    this.skipSpaces()
    if (this.peek() !== '{') return ''
    this.index++
    let text = ''
    let depth = 1
    while (!this.eof()) {
      const char = this.peek()
      this.index++
      if (char === '\\') {
        text += char + (this.peek() ?? '')
        this.index++
        continue
      }
      if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) break
      }
      text += char
    }
    return text
  }

  wrap(nodes, tag) {
    if (nodes.length === 1) return `<${tag}>${nodes[0]}</${tag}>`
    return `<${tag}><mrow>${nodes.join('')}</mrow></${tag}>`
  }

  parseAtom() {
    this.skipSpaces()
    if (this.eof()) return ''
    const char = this.peek()
    if (char === '{') {
      this.index++
      const node = this.parseExpression('}')
      if (this.peek() === '}') this.index++
      return node
    }
    if (char === '\\') {
      this.index++
      const name = this.readCommandName()
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const numerator = this.readGroup()
        const denominator = this.readGroup()
        return `<mfrac>${numerator}${denominator}</mfrac>`
      }
      if (name === 'sqrt') {
        this.skipSpaces()
        let index = ''
        if (this.peek() === '[') {
          this.index++
          let degree = ''
          while (!this.eof() && this.peek() !== ']') {
            degree += this.peek()
            this.index++
          }
          if (this.peek() === ']') this.index++
          index = `<mrow>${this.parseSubtext(degree)}</mrow>`
        }
        const body = this.readGroup()
        return index === '' ? `<msqrt>${body}</msqrt>` : `<mroot>${body}${index}</mroot>`
      }
      if (name === 'text' || name === 'mathrm' || name === 'mathbf' || name === 'mathit' || name === 'operatorname' || name === 'textrm') {
        const raw = this.readRawGroup()
        const tag = name === 'mathbf' ? 'mstyle mathvariant="bold"' : 'mtext'
        return `<${tag}>${escapeXml(raw)}</${tag}>`
      }
      if (name === 'tag') {
        const raw = this.readRawGroup()
        return `<mspace width="1em"></mspace><mtext>(${escapeXml(raw)})</mtext>`
      }
      if (name === 'begin' || name === 'end') {
        this.readRawGroup()
        return ''
      }
      if (name === 'left' || name === 'right') {
        this.skipSpaces()
        const delimiter = this.peek()
        if (delimiter !== '' && !/\s/.test(delimiter)) this.index++
        return delimiter === '.' ? '' : `<mo>${escapeXml(delimiter === '\\{' ? '{' : delimiter === '\\}' ? '}' : delimiter)}</mo>`
      }
      if (SPACING.has(name)) return '<mspace width="0.2em"></mspace>'
      if (ACCENTS[name] !== undefined) {
        const body = this.readGroup()
        return `<mover accent="true">${body}<mo>${ACCENTS[name]}</mo></mover>`
      }
      if (name === '\\') return '<mspace linebreak="newline"></mspace>'
      if (GREEK[name] !== undefined) return `<mi>${GREEK[name]}</mi>`
      if (SYMBOLS[name] !== undefined) {
        return FUNCTIONS.has(name) ? `<mi>${SYMBOLS[name]}</mi>` : `<mo>${SYMBOLS[name]}</mo>`
      }
      return `<mtext>${escapeXml(name)}</mtext>`
    }
    if (/[0-9]/.test(char)) {
      let digits = ''
      while (!this.eof() && /[0-9.]/.test(this.peek())) {
        digits += this.peek()
        this.index++
      }
      return `<mn>${escapeXml(digits)}</mn>`
    }
    if (/[A-Za-z]/.test(char)) {
      let letters = ''
      while (!this.eof() && /[A-Za-z]/.test(this.peek())) {
        letters += this.peek()
        this.index++
      }
      return `<mi>${escapeXml(letters)}</mi>`
    }
    this.index++
    if (char === '^' || char === '_') return ''
    if (OPERATORS.has(char)) return `<mo>${escapeXml(char)}</mo>`
    return `<mi>${escapeXml(char)}</mi>`
  }

  parseSubtext(raw) {
    const parser = new LatexParser(raw)
    return parser.parseExpression('')
  }

  /** Parse atoms with optional super/subscripts until `endChar` (not consumed). */
  parseExpression(endChar = '') {
    const nodes = []
    while (!this.eof()) {
      this.skipSpaces()
      if (endChar !== '' && this.peek() === endChar) break
      let atom = this.parseAtom()
      this.skipSpaces()
      let sub = ''
      let sup = ''
      while (!this.eof() && (this.peek() === '^' || this.peek() === '_')) {
        const kind = this.peek()
        this.index++
        const script = this.readGroup()
        if (kind === '^') sup = script
        else sub = script
        this.skipSpaces()
      }
      if (sub !== '' && sup !== '') atom = `<msubsup>${atom}${sub}${sup}</msubsup>`
      else if (sup !== '') atom = `<msup>${atom}${sup}</msup>`
      else if (sub !== '') atom = `<msub>${atom}${sub}</msub>`
      if (atom !== '') nodes.push(atom)
    }
    if (nodes.length === 0) return '<mrow></mrow>'
    return nodes.length === 1 ? nodes[0] : `<mrow>${nodes.join('')}</mrow>`
  }
}

/**
 * Convert a LaTeX fragment into a MathML string (display block), or '' when nothing usable.
 * @param {string} latex
 * @returns {string}
 */
export function latexToMathML(latex) {
  const source = String(latex ?? '').trim()
  if (source === '' || source.length > 2000) return ''
  // Reject obviously broken LaTeX (unbalanced groups / dangling command) instead of rendering
  // half an equation: the caller then falls back to the page crop or plain text.
  let depth = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '\\') {
      index++
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth < 0) return ''
    }
  }
  if (depth !== 0 || source.endsWith('\\')) return ''
  try {
    const parser = new LatexParser(source)
    const body = parser.parseExpression('')
    const rendered = body === '<mrow></mrow>' ? '' : body
    if (rendered === '') return ''
    return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow>${rendered}</mrow></math>`
  } catch {
    return ''
  }
}
