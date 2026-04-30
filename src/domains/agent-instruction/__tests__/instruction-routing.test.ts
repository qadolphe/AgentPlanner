import { describe, expect, it } from 'vitest'
import {
  buildDefaultInstructionDescription,
  buildInstructionTitle,
  parseInstructionRoutingDocument,
  serializeInstructionRoutingDocument,
} from '@/domains/agent-instruction/instruction-routing'

describe('buildInstructionTitle', () => {
  it('humanizes file names into readable titles', () => {
    expect(buildInstructionTitle('database-schema.md')).toBe('Database Schema')
  })
})

describe('buildDefaultInstructionDescription', () => {
  it('creates a readable default description', () => {
    expect(buildDefaultInstructionDescription('Auth Flows')).toBe(
      'Use when working with Auth Flows.'
    )
  })
})

describe('parseInstructionRoutingDocument', () => {
  it('defaults legacy content to always-on routing', () => {
    const parsed = parseInstructionRoutingDocument('# Architecture\n\nImportant context', {
      defaultTitle: 'Architecture',
      defaultDescription: 'Use when editing architecture docs.',
    })

    expect(parsed).toEqual({
      body: '# Architecture\n\nImportant context',
      config: {
        title: 'Architecture',
        mode: 'always',
        description: 'Use when editing architecture docs.',
        globs: '',
      },
    })
  })

  it('parses the new shared routing frontmatter', () => {
    const parsed = parseInstructionRoutingDocument(`---
title: "Auth Flows"
routingMode: "agent-decides"
description: "Use when debugging auth flows."
globs: ""
---

# Auth

Review login and merge behavior.`)

    expect(parsed).toEqual({
      body: '# Auth\n\nReview login and merge behavior.',
      config: {
        title: 'Auth Flows',
        mode: 'agent-decides',
        description: 'Use when debugging auth flows.',
        globs: '',
      },
    })
  })

  it('stays backward compatible with legacy cursor frontmatter', () => {
    const parsed = parseInstructionRoutingDocument(`---
description: "Use when working on schema changes."
globs: "src/**/*.ts"
alwaysApply: false
---

# Schema`)

    expect(parsed.config.mode).toBe('match-files')
    expect(parsed.config.description).toBe('Use when working on schema changes.')
    expect(parsed.config.globs).toBe('src/**/*.ts')
  })
})

describe('serializeInstructionRoutingDocument', () => {
  it('writes normalized shared routing frontmatter', () => {
    const serialized = serializeInstructionRoutingDocument('# UI\n\nFollow the design system.', {
      title: 'UI Rules',
      mode: 'match-files',
      description: 'ignored',
      globs: 'src/components/**/*.tsx, src/app/**/*.tsx ',
    })

    expect(serialized).toContain('routingMode: "match-files"')
    expect(serialized).toContain('globs: "src/components/**/*.tsx, src/app/**/*.tsx"')
    expect(serialized).toContain('# UI\n\nFollow the design system.')
  })
})
