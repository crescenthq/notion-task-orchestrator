import type {DashboardTextView} from './text'

export type DashboardScreenOptions = {
  columns?: number
  rows?: number
}

type ScreenSection = {
  title: string
  lines: string[]
  minLines: number
  idealLines: number
  growPriority: number
}

type SummaryEntry = {
  label: string
  value: string
}

type ParsedTable = {
  rows: string[][]
  messageLines: string[]
  noteLines: string[]
}

type DashboardScreenModel = {
  title: string
  stateEntries: SummaryEntry[]
  pipeLines: string[]
  activeLines: string[]
  taskLines: string[]
  eventLines: string[]
  footer: string
}

type Rgb = readonly [number, number, number]

const DEFAULT_COLUMNS = 120
const DEFAULT_ROWS = 34
const MIN_COLUMNS = 72
const MIN_ROWS = 20
const MAX_CONTENT_WIDTH = 100
const ANSI_RESET = '\u001B[0m'
const ANSI_BOLD = '\u001B[1m'
const ANSI_DIM = '\u001B[2m'
const LEDGER_SEPARATOR = '  ·  '
const LEDGER_THEME = {
  text: [205, 214, 244],
  subtext: [186, 194, 222],
  overlay: [108, 112, 134],
  lavender: [180, 190, 254],
  mauve: [203, 166, 247],
  sapphire: [116, 199, 236],
  blue: [137, 180, 250],
  green: [166, 227, 161],
  yellow: [249, 226, 175],
  red: [243, 139, 168],
  peach: [250, 179, 135],
  teal: [148, 226, 213],
} as const satisfies Record<string, Rgb>

export function renderDashboardScreen(
  view: DashboardTextView,
  options: DashboardScreenOptions = {},
): string {
  const columns = normalizeSize(options.columns, DEFAULT_COLUMNS, MIN_COLUMNS)
  const rows = normalizeSize(options.rows, DEFAULT_ROWS, MIN_ROWS)
  const contentWidth = Math.min(columns, MAX_CONTENT_WIDTH)
  const leftPad = ' '.repeat(
    Math.max(0, Math.floor((columns - contentWidth) / 2)),
  )
  const model = buildScreenModel(view, contentWidth)
  const lines = renderLedgerScreen(model, contentWidth, rows)

  return lines.map(line => `${leftPad}${line}`).join('\n')
}

function buildScreenModel(
  view: DashboardTextView,
  contentWidth: number,
): DashboardScreenModel {
  const header = parseHeader(view.header)
  const summary = parseSummary(view.summary)

  return {
    title: `NOTIONFLOW / ${header.project.toUpperCase()}`,
    stateEntries: summary.stateEntries,
    pipeLines:
      summary.pipeLines.length > 0
        ? summary.pipeLines.map(line => fitLine(line, contentWidth))
        : ['No pipes registered yet.'],
    activeLines: formatActiveLines(parseTable(view.inProgress), contentWidth),
    taskLines: formatTaskLines(parseTable(view.tasks), contentWidth),
    eventLines: formatEventLines(parseTable(view.events), contentWidth),
    footer: view.footer.replace(/\s+\|\s+/g, '  ·  '),
  }
}

function renderLedgerScreen(
  model: DashboardScreenModel,
  contentWidth: number,
  rows: number,
): string[] {
  const headerLines = [
    renderLedgerHeaderLine(model.title, 'LEDGER', contentWidth),
    ...renderLedgerStateLines(model.stateEntries, contentWidth),
    ...renderLedgerPipeLines(model.pipeLines, contentWidth),
    '',
  ]
  const sections: ScreenSection[] = [
    {
      title: 'NOW',
      lines: model.activeLines,
      minLines: 1,
      idealLines: 2,
      growPriority: 4,
    },
    {
      title: 'QUEUE',
      lines: model.taskLines,
      minLines: 4,
      idealLines: 6,
      growPriority: 3,
    },
    {
      title: 'EVENT',
      lines: model.eventLines,
      minLines: 2,
      idealLines: 4,
      growPriority: 2,
    },
  ]
  const footerLines = [
    '',
    colorize(
      fitLine(model.footer, contentWidth),
      ANSI_DIM,
      ansiTrueColor(LEDGER_THEME.overlay),
    ),
  ]
  const availableRows = rows - headerLines.length - footerLines.length
  const heights = allocateSectionHeights(
    sections,
    Math.max(sections.length, availableRows - sections.length + 1),
  )
  const bodyLines: string[] = []

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    const visibleLines = truncateLines(
      section.lines,
      heights[index] ?? section.minLines,
      contentWidth - 8,
    )

    visibleLines.forEach((line, lineIndex) => {
      if (lineIndex === 0) {
        bodyLines.push(
          renderLedgerSectionLine(section.title, line, contentWidth),
        )
        return
      }

      bodyLines.push(
        `${' '.repeat(7)} ${styleLedgerBodyLine(
          fitLine(line, contentWidth - 8),
        )}`,
      )
    })

    if (index < sections.length - 1) {
      bodyLines.push('')
    }
  }

  return [...headerLines, ...bodyLines, ...footerLines]
}

function parseHeader(header: string): {
  project: string
} {
  const lines = header.split('\n')
  const project = extractHeaderValue(lines, 'Project:') ?? 'workspace'
  return {project}
}

function parseSummary(summary: string): {
  stateEntries: SummaryEntry[]
  pipeLines: string[]
} {
  const stateEntries: SummaryEntry[] = []
  const pipeLines: string[] = []
  let mode: 'states' | 'pipes' | null = null

  for (const rawLine of summary.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line === 'States') {
      mode = 'states'
      continue
    }
    if (line === 'Pipes' || line === 'Workflows') {
      mode = 'pipes'
      continue
    }

    if (mode === 'states') {
      const match = line.match(/^(.+?)\s+(-?\d+|n\/a)$/i)
      if (match) {
        stateEntries.push({
          label: match[1].trim(),
          value: match[2],
        })
      } else {
        stateEntries.push({label: line, value: ''})
      }
      continue
    }

    if (mode === 'pipes') {
      pipeLines.push(normalizePipeLine(line))
    }
  }

  return {stateEntries, pipeLines}
}

function parseTable(content: string): ParsedTable {
  const trimmedLines = content
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)

  if (trimmedLines.length === 0) {
    return {
      rows: [],
      messageLines: ['No data available.'],
      noteLines: [],
    }
  }

  const ruleIndex = trimmedLines.findIndex(line => /^[-\s]{4,}$/.test(line))
  if (ruleIndex <= 0) {
    return {
      rows: [],
      messageLines: trimmedLines.map(line => line.trim()),
      noteLines: [],
    }
  }

  const rows: string[][] = []
  const noteLines: string[] = []

  for (const line of trimmedLines.slice(ruleIndex + 1)) {
    const normalized = line.trim()
    if (normalized.length === 0) continue
    if (normalized.startsWith('Showing ')) {
      noteLines.push(normalized)
      continue
    }
    rows.push(splitColumns(normalized))
  }

  if (rows.length === 0) {
    return {
      rows: [],
      messageLines: ['No rows available.'],
      noteLines,
    }
  }

  return {
    rows,
    messageLines: [],
    noteLines,
  }
}

function formatActiveLines(table: ParsedTable, contentWidth: number): string[] {
  if (table.rows.length === 0) {
    return table.messageLines.map(line =>
      fitLine(normalizeDashboardMessage(line), contentWidth),
    )
  }

  return [
    ...table.rows.map(row => formatActiveRow(row, contentWidth)),
    ...table.noteLines.map(line => fitLine(line, contentWidth)),
  ]
}

function formatTaskLines(table: ParsedTable, contentWidth: number): string[] {
  if (table.rows.length === 0) {
    return table.messageLines.map(line =>
      fitLine(normalizeDashboardMessage(line), contentWidth),
    )
  }

  return [
    ...table.rows.map(row => formatTaskRow(row, contentWidth)),
    ...table.noteLines.map(line => fitLine(line, contentWidth)),
  ]
}

function formatEventLines(table: ParsedTable, contentWidth: number): string[] {
  if (table.rows.length === 0) {
    return table.messageLines.map(line =>
      fitLine(normalizeDashboardMessage(line), contentWidth),
    )
  }

  return [
    ...table.rows.map(row => formatEventRow(row, contentWidth)),
    ...table.noteLines.map(line => fitLine(line, contentWidth)),
  ]
}

function formatActiveRow(row: string[], width: number): string {
  const [
    task = 'task',
    pipe = 'pipe',
    state = 'state',
    step = 'step',
    age = 'n/a',
  ] = row

  return renderColumns(
    [
      {text: task, width: 14},
      {text: `${pipe}/${step}`, width: 28},
      {text: state, width: 10},
      {text: age, width: 8, align: 'right'},
    ],
    width,
  )
}

function formatTaskRow(row: string[], width: number): string {
  const [
    task = 'task',
    pipe = 'pipe',
    state = 'state',
    step = 'step',
    age = 'n/a',
    detail = '',
  ] = row
  const detailWidth = Math.max(12, width - 66)

  return renderColumns(
    [
      {text: task, width: 14},
      {text: pipe, width: 10},
      {text: state, width: 10},
      {text: step, width: 14},
      {text: age, width: 6, align: 'right'},
      {text: detail, width: detailWidth},
    ],
    width,
  )
}

function formatEventRow(row: string[], width: number): string {
  const [time = '--:--', task = 'task', event = 'No event', age = 'n/a'] = row
  const eventWidth = Math.max(12, width - 34)

  return renderColumns(
    [
      {text: time, width: 8},
      {text: task, width: 12},
      {text: event, width: eventWidth},
      {text: age, width: 8, align: 'right'},
    ],
    width,
  )
}

function buildCompactPipeLines(
  pipeLines: string[],
  contentWidth: number,
): string[] {
  if (pipeLines.length === 0) {
    return ['pipes none']
  }

  if (pipeLines.length === 1 && pipeLines[0] === 'No pipes registered yet.') {
    return ['pipes none']
  }

  return wrapSegments(
    pipeLines.map(line => `pipe ${line}`),
    contentWidth,
  )
}

function renderLedgerHeaderLine(
  title: string,
  badge: string,
  width: number,
): string {
  return renderStyledColumns(
    title,
    colorize(title, ANSI_BOLD, ansiTrueColor(LEDGER_THEME.text)),
    badge,
    colorize(badge, ANSI_BOLD, ansiTrueColor(LEDGER_THEME.lavender)),
    width,
  )
}

function renderLedgerStateLines(
  entries: SummaryEntry[],
  width: number,
): string[] {
  if (entries.length === 0) {
    return [
      colorize(
        'No state counts available.',
        ansiTrueColor(LEDGER_THEME.overlay),
      ),
    ]
  }

  return wrapStyledSegments(
    entries.map(entry => {
      const plain = `${entry.label.toLowerCase()} ${entry.value}`
      return {
        plain,
        styled: colorize(plain, ansiTrueColor(colorForStateLabel(entry.label))),
      }
    }),
    width,
  )
}

function renderLedgerPipeLines(pipeLines: string[], width: number): string[] {
  return buildCompactPipeLines(pipeLines, width).map(line =>
    colorize(line, ansiTrueColor(LEDGER_THEME.sapphire)),
  )
}

function renderLedgerSectionLine(
  title: string,
  content: string,
  width: number,
): string {
  const label = title.toUpperCase()
  const gap = `${' '.repeat(Math.max(0, 7 - label.length))} `
  const body = styleLedgerBodyLine(fitLine(content, width - 8))

  return `${colorize(label, ANSI_BOLD, ansiTrueColor(colorForLedgerSection(label)))}${gap}${body}`
}

function styleLedgerBodyLine(line: string): string {
  if (line.startsWith('No ')) {
    return colorize(line, ansiTrueColor(LEDGER_THEME.subtext))
  }

  return colorize(line, ansiTrueColor(LEDGER_THEME.text))
}

function colorForLedgerSection(label: string): Rgb {
  switch (label.trim().toUpperCase()) {
    case 'NOW':
      return LEDGER_THEME.green
    case 'QUEUE':
      return LEDGER_THEME.blue
    case 'EVENT':
      return LEDGER_THEME.mauve
    default:
      return LEDGER_THEME.lavender
  }
}

function colorForStateLabel(label: string): Rgb {
  switch (label.trim().toLowerCase()) {
    case 'running':
      return LEDGER_THEME.green
    case 'feedback':
      return LEDGER_THEME.yellow
    case 'queued':
      return LEDGER_THEME.blue
    case 'failed':
      return LEDGER_THEME.red
    case 'blocked':
      return LEDGER_THEME.peach
    case 'done':
      return LEDGER_THEME.teal
    default:
      return LEDGER_THEME.subtext
  }
}

function wrapStyledSegments(
  segments: Array<{plain: string; styled: string}>,
  width: number,
): string[] {
  if (segments.length === 0) return []

  const separatorStyled = colorize(
    LEDGER_SEPARATOR,
    ansiTrueColor(LEDGER_THEME.overlay),
  )
  const lines: string[] = []
  let currentPlain = ''
  let currentStyled = ''

  for (const segment of segments) {
    if (currentPlain.length === 0) {
      currentPlain = segment.plain
      currentStyled = segment.styled
      continue
    }

    const nextPlain = `${currentPlain}${LEDGER_SEPARATOR}${segment.plain}`
    if (nextPlain.length <= width) {
      currentPlain = nextPlain
      currentStyled = `${currentStyled}${separatorStyled}${segment.styled}`
      continue
    }

    lines.push(currentStyled)
    currentPlain = segment.plain
    currentStyled = segment.styled
  }

  if (currentStyled.length > 0) {
    lines.push(currentStyled)
  }

  return lines
}

function wrapSegments(segments: string[], width: number): string[] {
  const lines: string[] = []
  let current = ''

  for (const segment of segments) {
    if (current.length === 0) {
      current = segment
      continue
    }

    const next = `${current}${LEDGER_SEPARATOR}${segment}`
    if (next.length <= width) {
      current = next
      continue
    }

    lines.push(fitLine(current, width))
    current = segment
  }

  if (current.length > 0) {
    lines.push(fitLine(current, width))
  }

  return lines
}

function allocateSectionHeights(
  sections: ScreenSection[],
  budget: number,
): number[] {
  const heights = sections.map(section =>
    Math.min(section.minLines, Math.max(1, section.lines.length)),
  )
  let remaining = budget - heights.reduce((sum, value) => sum + value, 0)

  const ordered = [...sections]
    .map((section, index) => ({section, index}))
    .sort(
      (left, right) => right.section.growPriority - left.section.growPriority,
    )

  const distribute = (mode: 'ideal' | 'full') => {
    let granted = true
    while (remaining > 0 && granted) {
      granted = false
      for (const entry of ordered) {
        const target =
          mode === 'ideal'
            ? Math.min(entry.section.idealLines, entry.section.lines.length)
            : entry.section.lines.length
        if (heights[entry.index] >= target) continue
        heights[entry.index] += 1
        remaining -= 1
        granted = true
        if (remaining === 0) break
      }
    }
  }

  if (remaining > 0) distribute('ideal')
  if (remaining > 0) distribute('full')

  return heights
}

function truncateLines(
  lines: string[],
  maxLines: number,
  width: number,
): string[] {
  const safeLines = lines.length > 0 ? lines : ['No data available.']
  const visible = safeLines.slice(0, Math.max(1, maxLines))

  if (safeLines.length > visible.length) {
    visible[visible.length - 1] = withEllipsis(
      visible[visible.length - 1] ?? '',
      width,
    )
  }

  return visible.map(line => fitLine(line, width))
}

function splitColumns(line: string): string[] {
  return line
    .split(/\s{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
}

function extractHeaderValue(lines: string[], prefix: string): string | null {
  const line = lines.find(entry => entry.startsWith(prefix))
  if (!line) return null
  return line.slice(prefix.length).trim()
}

function normalizePipeLine(line: string): string {
  return line.replace(/\s{2,}/g, LEDGER_SEPARATOR).trim()
}

function normalizeDashboardMessage(line: string): string {
  if (
    line ===
    'No local tasks found. Run `notionflow integrations notion sync` or create a task first.'
  ) {
    return 'No local tasks found. Sync Notion or create a task first.'
  }

  if (line === 'No run trace activity recorded yet.') {
    return 'No recent activity recorded yet.'
  }

  return line
}

function renderColumns(
  cells: Array<{
    text: string
    width: number
    align?: 'left' | 'right'
  }>,
  width: number,
): string {
  const output = cells
    .map(cell => {
      const value = fitLine(cell.text, cell.width)
      return cell.align === 'right'
        ? value.padStart(cell.width, ' ')
        : value.padEnd(cell.width, ' ')
    })
    .join('  ')
    .trimEnd()

  return fitLine(output, width)
}

function renderStyledColumns(
  leftPlain: string,
  leftStyled: string,
  rightPlain: string,
  rightStyled: string,
  width: number,
): string {
  if (leftPlain.length + rightPlain.length <= width) {
    const gap = ' '.repeat(width - leftPlain.length - rightPlain.length)
    return `${leftStyled}${gap}${rightStyled}`
  }

  const maxLeftWidth = Math.max(1, width - rightPlain.length - 1)
  return `${colorize(
    fitLine(leftPlain, maxLeftWidth),
    ANSI_BOLD,
    ansiTrueColor(LEDGER_THEME.text),
  )} ${rightStyled}`
}

function fitLine(line: string, width: number): string {
  const normalized = line.trimEnd()
  if (normalized.length <= width) return normalized
  return withEllipsis(normalized, width)
}

function withEllipsis(value: string, width: number): string {
  if (width <= 1) return '.'
  if (value.length <= width) return value
  return `${value.slice(0, width - 1).trimEnd()}.`
}

function normalizeSize(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(Number(value)))
}

function colorize(text: string, ...codes: string[]): string {
  return text.length > 0 ? `${codes.join('')}${text}${ANSI_RESET}` : text
}

function ansiTrueColor([red, green, blue]: Rgb): string {
  return `\u001B[38;2;${red};${green};${blue}m`
}
