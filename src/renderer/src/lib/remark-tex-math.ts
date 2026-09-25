import { factorySpace } from 'micromark-factory-space'
import { markdownLineEnding, markdownLineEndingOrSpace } from 'micromark-util-character'
import type { Code, Construct, Tokenizer } from 'micromark-util-types'
import type {} from 'micromark-extension-math'
import type {} from 'remark-parse'
import type { Processor } from 'unified'

/** Dollar/TeX delimiters participate in Markdown tokenization, before character
 * escapes. No source replacement: code, links, indentation and escaped
 * backslashes keep CommonMark semantics. Single dollars use Pandoc-style
 * whitespace/digit boundaries and preserve escaped dollars inside TeX.
 * Reuse remark-math's AST handlers and its multi-dollar/block syntax. */
export function remarkTexMath(this: Processor) {
  const data = this.data()
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  extensions.push({
    text: {
      92: { tokenize: textMath },
      36: { tokenize: textMath, previous(code) {
        return code !== 36 || this.events.at(-1)?.[1].type === 'characterEscape'
      } }
    },
    flow: { 92: { tokenize: flowMath, concrete: true } }
  })
}

const textMath: Tokenizer = function (effects, ok, nok) {
  let closing: number
  let dollar = false
  let previous: Code = null
  let dataStarted = false
  // A TeX command can be the very first character (including a streamed
  // opening backslash). Never close an empty data token while probing it as
  // a delimiter: micromark's development assertions reject that token.
  function consumeData(code: Code) {
    if (!dataStarted) {
      effects.enter('mathTextData')
      dataStarted = true
    }
    effects.consume(code)
  }
  function start(code: Code) {
    dollar = code === 36
    effects.enter('mathText')
    effects.enter('mathTextSequence')
    effects.consume(code)
    return open
  }
  function open(code: Code) {
    if (dollar) {
      if (code === null || code === 36 || markdownLineEndingOrSpace(code)) return nok(code)
      effects.exit('mathTextSequence')
      return content(code)
    }
    if (code !== 40 && code !== 91) return nok(code)
    closing = code === 40 ? 41 : 93
    effects.consume(code)
    effects.exit('mathTextSequence')
    return content
  }
  function content(code: Code): ReturnType<typeof ok> {
    if (code === null) return nok(code)
    if (dollar && code === 36) {
      // Reject at tokenization, not after parsing: "$5 and $x$" must leave
      // the second dollar available to start the actual formula.
      if (previous === null || markdownLineEndingOrSpace(previous)) return nok(code)
      return effects.attempt(closeDollar, ok, nok)(code)
    }
    if (code === 92) return dollar ? escape(code) : effects.attempt(close, ok, escape)(code)
    previous = code
    consumeData(code)
    return content
  }
  // A doubled backslash belongs to TeX, never starts the closing delimiter.
  function escape(code: Code) {
    consumeData(code)
    return escaped
  }
  function escaped(code: Code) {
    if (code === null) return nok(code)
    previous = code
    consumeData(code)
    return content
  }
  const close: Construct = { partial: true, tokenize(effects, ok, nok) {
    return slash
    function slash(code: Code) {
      if (dataStarted) effects.exit('mathTextData')
      effects.enter('mathTextSequence')
      effects.consume(code)
      return end
    }
    function end(code: Code) {
      if (code !== closing) return nok(code)
      effects.consume(code)
      effects.exit('mathTextSequence')
      effects.exit('mathText')
      return ok
    }
  } }
  const closeDollar: Construct = { partial: true, tokenize(effects, ok, nok) {
    return marker
    function marker(code: Code) {
      if (dataStarted) effects.exit('mathTextData')
      effects.enter('mathTextSequence')
      effects.consume(code)
      return end
    }
    function end(code: Code) {
      if (code === 36 || (code !== null && code >= 48 && code <= 57)) return nok(code)
      effects.exit('mathTextSequence')
      effects.exit('mathText')
      return ok(code)
    }
  } }
  return start
}

/** A standalone \[ owns its blank lines, including in lists/quotes. The
 * non-lazy continuation is the same boundary used by fenced Markdown math. */
const flowMath: Tokenizer = function (effects, ok, nok) {
  const self = this
  function start(code: Code) {
    effects.enter('mathFlow')
    effects.enter('mathFlowFence')
    effects.enter('mathFlowFenceSequence')
    effects.consume(code)
    return open
  }
  function open(code: Code) {
    if (code !== 91) return nok(code)
    effects.consume(code)
    effects.exit('mathFlowFenceSequence')
    return factorySpace(effects, afterOpen, 'whitespace')
  }
  function afterOpen(code: Code) {
    if (code !== null && !markdownLineEnding(code)) return nok(code)
    effects.exit('mathFlowFence')
    if (self.interrupt) return ok(code)
    return nextLine(code)
  }
  function nextLine(code: Code): ReturnType<typeof ok> {
    if (code === null) return after(code)
    return effects.attempt(nonLazy, beforeContent, after)(code)
  }
  function beforeContent(code: Code): ReturnType<typeof ok> {
    return effects.attempt(close, after, contentStart)(code)
  }
  function contentStart(code: Code): ReturnType<typeof ok> {
    if (code === null) return after(code)
    if (markdownLineEnding(code)) return nextLine(code)
    effects.enter('mathFlowValue')
    return content(code)
  }
  function content(code: Code): ReturnType<typeof ok> {
    if (code === null || markdownLineEnding(code)) {
      effects.exit('mathFlowValue')
      return code === null ? after(code) : nextLine(code)
    }
    effects.consume(code)
    return content
  }
  function after(code: Code) {
    effects.exit('mathFlow')
    return ok(code)
  }
  const close: Construct = { partial: true, tokenize(effects, ok, nok) {
    return factorySpace(effects, slash, 'linePrefix', 4)
    function slash(code: Code) {
      if (code !== 92) return nok(code)
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      effects.consume(code)
      return bracket
    }
    function bracket(code: Code) {
      if (code !== 93) return nok(code)
      effects.consume(code)
      effects.exit('mathFlowFenceSequence')
      return factorySpace(effects, end, 'whitespace')
    }
    function end(code: Code) {
      if (code !== null && !markdownLineEnding(code)) return nok(code)
      effects.exit('mathFlowFence')
      return ok(code)
    }
  } }
  return start
}

const nonLazy: Construct = { partial: true, tokenize(effects, ok, nok) {
  const self = this
  return start
  function start(code: Code) {
    effects.enter('lineEnding')
    effects.consume(code)
    effects.exit('lineEnding')
    return next
  }
  function next(code: Code) {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code)
  }
} }
