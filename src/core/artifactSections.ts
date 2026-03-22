type ArtifactSection = {
  heading: string
  content: string
}

type ParsedArtifact = {
  preamble: string
  sections: ArtifactSection[]
}

function normalizeHeading(heading: string): string {
  return heading.trim()
}

function normalizeSectionContent(content: string): string {
  return content.replace(/^\n+/, '').replace(/\n+$/, '')
}

function trimTrailingNewlines(content: string): string {
  return content.replace(/\n+$/, '')
}

function parseArtifact(markdown: string): ParsedArtifact {
  const sectionHeadingPattern = /^##[ \t]+(.+?)\s*$/gm
  const headings: Array<{heading: string; start: number; contentStart: number}> =
    []

  let match: RegExpExecArray | null
  while ((match = sectionHeadingPattern.exec(markdown)) !== null) {
    const lineBreakIndex = markdown.indexOf('\n', match.index)
    headings.push({
      heading: normalizeHeading(match[1] ?? ''),
      start: match.index,
      contentStart: lineBreakIndex === -1 ? markdown.length : lineBreakIndex + 1,
    })
  }

  const preambleEnd = headings[0]?.start ?? markdown.length
  const sections = headings.map((heading, index) => {
    const nextHeadingStart = headings[index + 1]?.start ?? markdown.length
    return {
      heading: heading.heading,
      content: normalizeSectionContent(
        markdown.slice(heading.contentStart, nextHeadingStart),
      ),
    }
  })

  return {
    preamble: trimTrailingNewlines(markdown.slice(0, preambleEnd)),
    sections,
  }
}

function serializeArtifact(parsed: ParsedArtifact): string {
  const parts: string[] = []
  const preamble = trimTrailingNewlines(parsed.preamble)

  if (preamble.length > 0) parts.push(preamble)

  for (const section of parsed.sections) {
    const content = normalizeSectionContent(section.content)
    parts.push(
      content.length === 0 ? `## ${section.heading}` : `## ${section.heading}\n${content}`,
    )
  }

  return parts.join('\n\n')
}

export function readSection(markdown: string, heading: string): string | null {
  const normalizedHeading = normalizeHeading(heading)
  const section = parseArtifact(markdown).sections.find(
    candidate => candidate.heading === normalizedHeading,
  )
  return section?.content ?? null
}

export function writeSection(
  markdown: string,
  heading: string,
  content: string,
): string {
  const normalizedHeading = normalizeHeading(heading)
  const parsed = parseArtifact(markdown)
  const nextContent = normalizeSectionContent(content)
  const existingSection = parsed.sections.find(
    candidate => candidate.heading === normalizedHeading,
  )

  if (existingSection) {
    existingSection.content = nextContent
  } else {
    parsed.sections.push({heading: normalizedHeading, content: nextContent})
  }

  return serializeArtifact(parsed)
}

export function removeSection(markdown: string, heading: string): string {
  const normalizedHeading = normalizeHeading(heading)
  const parsed = parseArtifact(markdown)

  parsed.sections = parsed.sections.filter(
    candidate => candidate.heading !== normalizedHeading,
  )

  return serializeArtifact(parsed)
}
