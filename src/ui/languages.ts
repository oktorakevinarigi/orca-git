// What the diff highlighter needs to know about each language: comments, strings and word lists.

export interface Language {
  lineComments: string[]
  blockComment?: [open: string, close: string]
  /** Quotes of one-line strings. */
  quotes: string[]
  /** Delimiters of strings that may span lines (template literals, Python's triple quotes). */
  multilineStrings: string[]
  keywords: Set<string>
  /** Built-in types, colored like type names. */
  types: Set<string>
  constants: Set<string>
  /** `name:` is a key (JSON, YAML, CSS properties). */
  keysBeforeColon?: boolean
  /** Capitalized names are types (C-family languages). */
  capitalizedTypes?: boolean
  /** Identifiers may contain `-` (CSS, shell options). */
  dashedNames?: boolean
  caseInsensitive?: boolean
  /** Markup: `<tag attr="…">`. */
  markup?: boolean
}

const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean))

const C_LIKE_CONSTANTS = words('true false null nullptr NULL')
const JS_KEYWORDS = words(`abstract as async await break case catch class const continue debugger declare default delete do
  else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let
  module namespace new of override private protected public readonly return satisfies set static super switch this throw
  try type typeof var void while with yield`)

function language(spec: Partial<Language> & Pick<Language, 'keywords'>): Language {
  return { lineComments: [], quotes: [], multilineStrings: [], types: new Set(), constants: new Set(), ...spec }
}

const js = language({
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  multilineStrings: ['`'],
  keywords: JS_KEYWORDS,
  types: words('string number boolean bigint symbol object unknown any never void Array Promise Record Map Set Date Error'),
  constants: words('true false null undefined NaN Infinity'),
  capitalizedTypes: true
})

const cFamily = (keywords: string, types = '', extra: Partial<Language> = {}) =>
  language({
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    keywords: words(keywords),
    types: words(types),
    constants: C_LIKE_CONSTANTS,
    capitalizedTypes: true,
    ...extra
  })

const python = language({
  lineComments: ['#'],
  quotes: ['"', "'"],
  multilineStrings: ['"""', "'''"],
  keywords: words(`and as assert async await break class continue def del elif else except finally for from global if
    import in is lambda match case nonlocal not or pass raise return try while with yield self cls`),
  types: words('int float str bool bytes list dict set tuple object type'),
  constants: words('True False None'),
  capitalizedTypes: true
})

const shell = language({
  lineComments: ['#'],
  quotes: ['"', "'"],
  keywords: words('if then else elif fi for while until do done case esac in function return local export source exit set unset'),
  constants: words('true false'),
  dashedNames: true
})

const json = language({ quotes: ['"'], keywords: new Set(), constants: words('true false null'), keysBeforeColon: true })

const yaml = language({
  lineComments: ['#'],
  quotes: ['"', "'"],
  keywords: new Set(),
  constants: words('true false null yes no on off ~'),
  keysBeforeColon: true,
  dashedNames: true
})

const css = language({
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  keywords: words('@media @import @use @forward @include @mixin @extend @keyframes @font-face @supports @layer @container !important'),
  constants: words('inherit initial unset none auto'),
  keysBeforeColon: true,
  dashedNames: true
})

const markup = language({ blockComment: ['<!--', '-->'], quotes: ['"', "'"], keywords: new Set(), markup: true, dashedNames: true })

const sql = language({
  lineComments: ['--'],
  blockComment: ['/*', '*/'],
  quotes: ["'", '"'],
  keywords: words(`select from where join left right inner outer full on and or not in is as insert into values update set
    delete create alter drop table index view order by group having limit offset union all distinct case when then else
    end returning primary key foreign references default exists between like`),
  types: words('int integer bigint text varchar char boolean date timestamp numeric serial uuid json jsonb'),
  constants: words('null true false'),
  caseInsensitive: true
})

const LANGUAGES: Record<string, Language> = {
  js, jsx: js, mjs: js, cjs: js, ts: js, tsx: js, mts: js, cts: js, vue: js, svelte: js,
  java: cFamily(
    'abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static super switch synchronized this throw throws transient try var volatile while record yield',
    'int long short byte char boolean float double void String Object'
  ),
  kt: cFamily(
    'as break class continue do else for fun if in interface is object package return super this throw try typealias val var when while import data sealed open override private protected public internal companion suspend',
    'Int Long Short Byte Char Boolean Float Double Unit String Any'
  ),
  c: cFamily('auto break case const continue default do else enum extern for goto if inline register return sizeof static struct switch typedef union volatile while include define ifdef ifndef endif', 'int long short char float double void unsigned signed size_t bool'),
  cs: cFamily('abstract as async await base break case catch class const continue default delegate do else enum event explicit extern finally fixed for foreach if implicit in interface internal is lock namespace new operator out override params private protected public readonly record ref return sealed sizeof static struct switch this throw try typeof using var virtual void while', 'int long short byte char bool float double decimal string object'),
  go: cFamily('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var', 'int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any', { constants: words('true false nil iota'), capitalizedTypes: false }),
  rs: cFamily('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while', 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box', { constants: words('true false None Some Ok Err') }),
  swift: cFamily('as break case catch class continue default defer do else enum extension fallthrough for func guard if import in init let protocol return self static struct switch throw throws try var where while', 'Int Double Float Bool String Character Void', { constants: words('true false nil') }),
  php: cFamily('abstract as break case catch class const continue declare default do echo else elseif extends final finally fn for foreach function if implements include interface namespace new private protected public require return static switch throw trait try use var while', 'int float string bool array object mixed void', { lineComments: ['//', '#'] }),
  py: python,
  rb: language({ lineComments: ['#'], quotes: ['"', "'"], keywords: words('alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then unless until when while yield require attr_accessor'), constants: words('true false nil'), capitalizedTypes: true }),
  sh: shell, bash: shell, zsh: shell,
  json, jsonc: json,
  yml: yaml, yaml, toml: yaml,
  css, scss: css, less: css,
  html: markup, htm: markup, xml: markup, svg: markup,
  sql
}

const FILE_NAMES: Record<string, Language> = { dockerfile: shell, makefile: shell, '.bashrc': shell, '.zshrc': shell }

/** The language of a file from its name, or null when the diff stays plain. */
export function languageFor(path: string): Language | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (FILE_NAMES[name]) return FILE_NAMES[name]
  const dot = name.lastIndexOf('.')
  return dot < 0 ? null : (LANGUAGES[name.slice(dot + 1)] ?? null)
}
