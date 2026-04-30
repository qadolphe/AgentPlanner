export const INSTRUCTION_ROUTING_MODES = ['always', 'match-files', 'agent-decides'] as const

export type InstructionRoutingMode = (typeof INSTRUCTION_ROUTING_MODES)[number]

export type InstructionRoutingConfig = {
  title: string
  mode: InstructionRoutingMode
  description: string
  globs: string
}

export type ParsedInstructionDocument = {
  body: string
  config: InstructionRoutingConfig
}

const FRONTMATTER_START = '---\n'
const FRONTMATTER_END = '\n---\n'
const DEFAULT_TITLE = 'Untitled Instruction'

function splitFrontmatter(source: string) {
  const normalized = source.replace(/\r\n/g, '\n')
  if (!normalized.startsWith(FRONTMATTER_START)) {
    return null
  }

  const closingIndex = normalized.indexOf(FRONTMATTER_END, FRONTMATTER_START.length)
  if (closingIndex === -1) {
    return null
  }

  return {
    frontmatter: normalized.slice(FRONTMATTER_START.length, closingIndex),
    body: normalized.slice(closingIndex + FRONTMATTER_END.length),
  }
}

function parseFrontmatterString(rawValue: string) {
  const trimmedValue = rawValue.trim()
  if (!trimmedValue) {
    return ''
  }

  if (trimmedValue.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmedValue)
      return typeof parsed === 'string' ? parsed : trimmedValue
    } catch {
      return trimmedValue
    }
  }

  if (
    (trimmedValue.startsWith("'") && trimmedValue.endsWith("'")) ||
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"'))
  ) {
    return trimmedValue.slice(1, -1)
  }

  return trimmedValue
}

function normalizeGlobs(globs: string) {
  return globs
    .split(',')
    .map((glob) => glob.trim())
    .filter(Boolean)
    .join(', ')
}

function humanizeTitle(rawValue: string) {
  const normalized = rawValue
    .trim()
    .replace(/\.[^.]+$/u, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')

  if (!normalized) {
    return DEFAULT_TITLE
  }

  return normalized.replace(/\b\w/g, (character) => character.toUpperCase())
}

export function buildInstructionTitle(rawValue: string) {
  return humanizeTitle(rawValue)
}

export function buildDefaultInstructionDescription(title: string) {
  return `Use when working with ${title.trim() || DEFAULT_TITLE}.`
}

export function parseInstructionRoutingDocument(
  source: string,
  options?: { defaultTitle?: string; defaultDescription?: string }
): ParsedInstructionDocument {
  const defaultTitle = options?.defaultTitle?.trim() || DEFAULT_TITLE
  const defaultDescription = options?.defaultDescription?.trim() || ''
  const frontmatter = splitFrontmatter(source)

  if (!frontmatter) {
    return {
      body: source,
      config: {
        title: defaultTitle,
        mode: 'always',
        description: defaultDescription,
        globs: '',
      },
    }
  }

  let title = defaultTitle
  let description = defaultDescription
  let globs = ''
  let routingMode: InstructionRoutingMode | null = null
  let alwaysApply = false

  for (const line of frontmatter.frontmatter.split('\n')) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1)

    if (key === 'title') {
      title = parseFrontmatterString(value) || defaultTitle
      continue
    }

    if (key === 'description') {
      description = parseFrontmatterString(value)
      continue
    }

    if (key === 'globs') {
      globs = normalizeGlobs(parseFrontmatterString(value))
      continue
    }

    if (key === 'routingMode') {
      const parsedMode = parseFrontmatterString(value) as InstructionRoutingMode
      if (INSTRUCTION_ROUTING_MODES.includes(parsedMode)) {
        routingMode = parsedMode
      }
      continue
    }

    if (key === 'alwaysApply') {
      alwaysApply = value.trim() === 'true'
    }
  }

  const mode: InstructionRoutingMode =
    routingMode ??
    (alwaysApply ? 'always' : globs ? 'match-files' : description ? 'agent-decides' : 'always')

  return {
    body: frontmatter.body.replace(/^\n+/, ''),
    config: {
      title,
      mode,
      description,
      globs,
    },
  }
}

export function serializeInstructionRoutingDocument(
  body: string,
  config: InstructionRoutingConfig
) {
  const normalizedTitle = config.title.trim() || DEFAULT_TITLE
  const normalizedMode = config.mode
  const normalizedDescription =
    normalizedMode === 'agent-decides' ? config.description.trim() : ''
  const normalizedGlobs =
    normalizedMode === 'match-files' ? normalizeGlobs(config.globs) : ''

  const lines = [
    '---',
    `title: ${JSON.stringify(normalizedTitle)}`,
    `routingMode: ${JSON.stringify(normalizedMode)}`,
    `description: ${JSON.stringify(normalizedDescription)}`,
    `globs: ${JSON.stringify(normalizedGlobs)}`,
    '---',
    '',
    body.trim(),
  ]

  return lines.join('\n').trimEnd()
}
