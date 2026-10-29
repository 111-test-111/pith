/** Formula-local compatibility for common LaTeX package syntax. Use Temml's
 * macro tokens, rather than rewriting Markdown/TeX strings: comments, \verb,
 * escaped commands and the original TeX annotation keep their meaning. */
interface Token {
  text: string
  noexpand?: boolean
}

interface MacroContext {
  consumeArgs(count: number): Token[][]
  consumeSpaces(): void
  popToken(): Token
  future(): Token
  expandTokens(tokens: Token[]): Token[]
  macros: {
    get(name: string): unknown
  }
}

interface Expansion {
  tokens: Token[]
  numArgs: number
}

type Macro = string | ((context: MacroContext) => Expansion)

const SMALL_FENCES: Record<string, [string, string]> = {
  p: ['(', ')'], b: ['[', ']'], B: ['\\{', '\\}'],
  v: ['|', '|'], V: ['\\Vert', '\\Vert']
}

const token = (text: string): Token => ({ text })
const group = (body: Token[]): Token[] => [token('{'), ...body, token('}')]
const characters = (text: string): Token[] => [...text].map(token)
const expansion = (tokens: Token[]): Expansion => ({ tokens: tokens.reverse(), numArgs: 0 })
const argument = (context: MacroContext): Token[] => context.consumeArgs(1)[0].reverse()
const nameOf = (tokens: Token[]): string => tokens.map(part => part.text).join('')
const environmentName = (context: MacroContext, tokens: Token[]): string =>
  nameOf(context.expandTokens([...tokens].reverse()))

// noexpand delegates back to the native function without invoking our macro
// again. Synthetic tokens are explicitly supported by Temml's macro API.
const native = (command: string, ...args: Token[][]): Token[] => [
  { text: command, noexpand: true }, ...args.flatMap(group)
]

function optionalAlignment(context: MacroContext): string {
  context.consumeSpaces()
  if (context.future().text !== '[') return 'c'
  context.popToken()
  context.consumeSpaces()
  const align = context.popToken().text
  context.consumeSpaces()
  if (!['l', 'c', 'r'].includes(align) || context.popToken().text !== ']') {
    throw new Error('Invalid smallmatrix column alignment')
  }
  return align
}

/** Read one complete environment from the native lexer. Nested environments
 * retain their tokens for the parser; malformed/mismatched input still fails. */
function environmentBody(context: MacroContext, name: string): Token[] {
  const stack = [name]
  const body: Token[] = []
  while (stack.length) {
    const part = context.popToken()
    if (part.text === 'EOF') throw new Error(`Unclosed environment: ${name}`)
    if (part.text === '\\begin' || part.text === '\\end') {
      const args = argument(context)
      const environment = environmentName(context, args)
      if (part.text === '\\begin') stack.push(environment)
      else if (stack.pop() !== environment) throw new Error('Mismatched math environments')
      if (!stack.length) break
      body.push(part, ...group(args))
    } else body.push(part)
  }
  return body
}

/** Transform only top-level cells. Braced text and nested arrays own their
 * separators; row spacing arguments stay outside the next cell's styling. */
function mapCells(body: Token[], map: (cells: Token[][]) => Token[]): Token[] {
  const result: Token[] = []
  let cells: Token[][] = [[]]
  let braces = 0
  let environments = 0
  const flush = () => {
    // Leave a trailing empty row empty so the native array parser can trim it.
    result.push(...(cells.length === 1 && !nameOf(cells[0]).trim() ? cells[0] : map(cells)))
    cells = [[]]
  }
  for (let i = 0; i < body.length; i++) {
    const part = body[i]
    if (!braces && !environments && part.text === '&') {
      cells.push([])
      continue
    }
    if (!braces && !environments && (part.text === '\\\\' || part.text === '\\cr')) {
      flush()
      result.push(part)
      if (part.text === '\\\\' && body[i + 1]?.text === '[') {
        do {
          result.push(body[++i])
          if (i === body.length - 1 && body[i].text !== ']') throw new Error('Unclosed row spacing')
        } while (body[i].text !== ']')
      }
      continue
    }
    if (part.text === '{') braces++
    if (part.text === '}') braces--
    if (part.text === '\\begin') environments++
    if (part.text === '\\end') environments--
    cells.at(-1)!.push(part)
  }
  flush()
  return result
}

const joinCells = (cells: Token[][]): Token[] => cells.flatMap((cell, index) =>
  index ? [token('&'), ...cell] : cell)

export function createMathMacros(): Record<string, Macro> {
  // These font aliases preserve double-struck semantics using the configured
  // math face, rather than importing the packages' document-specific fonts.
  const aliases: Record<string, string> = {
    '\\mathds': '\\mathbb{#1}', '\\mathbbm': '\\mathbb{#1}',
    // Common quantum shorthand: imaginary unit and a pure-state projector.
    // Formula-local definitions can override these defaults like other aliases.
    '\\ii': 'i', '\\proj': '\\ket{#1}\\!\\bra{#1}',
    '\\mspace': '\\mskip{#1}',
    '\\esssup': '\\operatorname*{ess\\,sup}',
    '\\essinf': '\\operatorname*{ess\\,inf}'
  }
  for (const name of [
    'diag', 'Diag', 'nullity', 'Var', 'Cov', 'cov', 'Corr', 'corr', 'Span',
    'sech', 'csch', 'arccot', 'arcsec', 'arccsc', 'arcsinh', 'arccosh',
    'arctanh', 'arsinh', 'arcosh', 'artanh', 'erfc'
  ]) aliases[`\\${name}`] = `\\operatorname{${name}}`

  const stack: { name: string; target: Token[]; closing: Token[] }[] = []
  const macros: Record<string, Macro> = { ...aliases }
  for (const command of ['\\newcommand', '\\renewcommand', '\\providecommand']) {
    macros[command] = context => {
      context.consumeSpaces()
      if (context.future().text === '*') context.popToken()
      const args = argument(context)
      const name = nameOf(args)
      // An explicit user definition takes precedence over our default aliases.
      const target = Object.hasOwn(aliases, name) && context.macros.get(name) === aliases[name]
        ? '\\renewcommand' : command
      return expansion(native(target, args))
    }
  }
  macros['\\DeclareMathOperator'] = context => {
    context.consumeSpaces()
    const starred = context.future().text === '*'
    if (starred) context.popToken()
    const name = argument(context)
    const text = argument(context)
    return expansion([
      token('\\def'), ...name,
      ...group([token('\\operatorname'), ...(starred ? [token('*')] : []), ...group(text)])
    ])
  }
  macros['\\begin'] = context => {
    const args = argument(context)
    const name = environmentName(context, args)
    const small = /^([pbBvV]?)smallmatrix(\*)?$/.exec(name)
    if (small && (small[1] || small[2])) {
      const fences = SMALL_FENCES[small[1]]
      const opening = fences ? [token('\\left'), token(fences[0]), token('\\,')] : []
      const closing = fences ? [token('\\,'), token('\\right'), token(fences[1])] : []
      const align = small[2] ? optionalAlignment(context) : 'c'
      if (align !== 'c') {
        const body = mapCells(environmentBody(context, name), cells =>
          joinCells(cells.map(cell => [token('\\scriptstyle'), ...cell])))
        // Native matrix* supplies real l/r alignment; script style and local
        // array gaps retain the compact matrix's scale and spacing.
        return expansion(group([
          token('\\scriptstyle'), token('\\def'), token('\\arraycolsep'), ...group(characters('0.1389em')),
          token('\\def'), token('\\arraystretch'), ...group(characters('0.65')),
          ...opening, ...native('\\begin', characters('matrix*')),
          token('['), token(align), token(']'), ...body,
          ...native('\\end', characters('matrix*')), ...closing
        ]))
      }
      stack.push({ name, target: characters('smallmatrix'), closing })
      return expansion([...opening, ...native('\\begin', characters('smallmatrix'))])
    }
    if (/^d?r?cases\*$/.test(name)) {
      const target = name.slice(0, -1)
      const body = mapCells(environmentBody(context, name), cells => {
        if (cells.length > 2) throw new Error('Cases accept at most two columns')
        return joinCells([cells[0], [token('\\text'), ...group(cells[1] ?? [])]])
      })
      return expansion([...native('\\begin', characters(target)), ...body, ...native('\\end', characters(target))])
    }
    if (name === 'eqnarray' || name === 'eqnarray*') {
      const target = name === 'eqnarray' ? 'align' : 'align*'
      const body = mapCells(environmentBody(context, name), cells => {
        if (cells.length > 3) throw new Error('Eqnarray accepts at most three columns')
        return cells.length === 3
          ? joinCells([cells[0], [...group([]), ...cells[1], ...group([]), ...cells[2]]])
          : joinCells(cells)
      })
      return expansion([...native('\\begin', characters(target)), ...body, ...native('\\end', characters(target))])
    }
    stack.push({ name, target: args, closing: [] })
    return expansion(native('\\begin', args))
  }
  macros['\\end'] = context => {
    const args = argument(context)
    const frame = stack.pop()
    if (!frame || frame.name !== environmentName(context, args)) throw new Error('Mismatched math environments')
    return expansion([...native('\\end', frame.target), ...frame.closing])
  }
  return macros
}
