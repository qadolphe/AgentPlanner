export const CORE_MCP_TOOL_CATALOG = [
  {
    id: 'get_project_board',
    name: 'Read Board',
    description: 'Allow agents to read project tasks, tags, and instruction context.',
  },
  {
    id: 'get_task_details',
    name: 'Read Task Details',
    description: 'Allow agents to inspect plans, timeline, and review thread details.',
  },
  {
    id: 'list_abyss_tasks',
    name: 'Read Abyss',
    description: 'Allow agents to inspect deleted and archived tasks.',
  },
  {
    id: 'list_project_tags',
    name: 'Read Tags',
    description: 'Allow agents to view tag metadata.',
  },
  {
    id: 'create_task',
    name: 'Create Tasks',
    description: 'Allow agents to create new tickets.',
  },
  {
    id: 'update_task',
    name: 'Update Task Fields',
    description: 'Allow agents to edit title, description, priority, and assignments.',
  },
  {
    id: 'move_task',
    name: 'Move Tasks',
    description: 'Allow agents to change board stage and ordering.',
  },
  {
    id: 'set_task_signal',
    name: 'Set Task Signals',
    description: 'Allow agents to set or clear review/help overlays.',
  },
  {
    id: 'list_task_messages',
    name: 'Read Task Messages',
    description: 'Allow agents to read workflow thread messages.',
  },
  {
    id: 'add_task_message',
    name: 'Add Task Messages',
    description: 'Allow agents to post workflow thread messages.',
  },
  {
    id: 'move_task_to_abyss',
    name: 'Move To Abyss',
    description: 'Allow agents to soft-delete tasks from the board.',
  },
  {
    id: 'restore_task',
    name: 'Restore From Abyss',
    description: 'Allow agents to restore deleted or archived tasks.',
  },
  {
    id: 'add_plan_to_task',
    name: 'Attach Plans',
    description: 'Allow agents to attach markdown implementation plans to tasks.',
  },
  {
    id: 'create_tag',
    name: 'Create Tags',
    description: 'Allow agents to create new tags.',
  },
  {
    id: 'delete_tag',
    name: 'Delete Tags',
    description: 'Allow agents to delete tags.',
  },
  {
    id: 'export_tasks',
    name: 'Export Tasks',
    description: 'Allow agents to generate prompt exports from board tasks.',
  },
] as const

export type CoreMcpToolId = (typeof CORE_MCP_TOOL_CATALOG)[number]['id']

export const INSTRUCTION_SYNC_TARGET_CATALOG = [
  {
    id: 'sync_target_vscode',
    name: 'VS Code',
    file_path: '.github/copilot-instructions.md + .github/instructions/*.instructions.md',
    description:
      'Write synced instructions to `.github/copilot-instructions.md` and managed `.github/instructions/*.instructions.md` files.',
    default_enabled: false,
  },
  {
    id: 'sync_target_cursor',
    name: 'Cursor',
    file_path: '.cursor/rules/*.mdc',
    description: 'Write synced instructions to managed Cursor project rules in `.cursor/rules/`.',
    default_enabled: false,
  },
  {
    id: 'sync_target_codex',
    name: 'Codex',
    file_path: 'AGENTS.md',
    description: 'Write synced instructions to `AGENTS.md`.',
    default_enabled: false,
  },
  {
    id: 'sync_target_claude',
    name: 'Claude Code',
    file_path: 'CLAUDE.md',
    description: 'Write synced instructions to `CLAUDE.md`.',
    default_enabled: false,
  },
  {
    id: 'sync_target_windsurf',
    name: 'Windsurf',
    file_path: '.windsurf/rules/*.md',
    description: 'Write synced instructions to managed Windsurf workspace rules in `.windsurf/rules/`.',
    default_enabled: false,
  },
  {
    id: 'sync_target_antigravity',
    name: 'Antigravity',
    file_path: 'antigravity.md',
    description: 'Write synced instructions to `antigravity.md`.',
    default_enabled: false,
  },
] as const

export type InstructionSyncTargetId = (typeof INSTRUCTION_SYNC_TARGET_CATALOG)[number]['id']
export type ToggleId = CoreMcpToolId | InstructionSyncTargetId

export type ToolToggleMap = Record<ToggleId, boolean>

export type ProjectAgentControls = {
  project_id: string
  allow_task_completion: boolean
  tool_toggles: ToolToggleMap
  created_at: string
  updated_at: string
  updated_by: string | null
}

export function getDefaultToolToggles(): ToolToggleMap {
  const toolEntries = CORE_MCP_TOOL_CATALOG.map((tool) => [tool.id, true] as const)
  const targetEntries = INSTRUCTION_SYNC_TARGET_CATALOG.map((target) => [
    target.id,
    target.default_enabled,
  ] as const)
  const entries = [...toolEntries, ...targetEntries]
  return Object.fromEntries(entries) as ToolToggleMap
}

export function normalizeToolToggles(rawValue: unknown): ToolToggleMap {
  const defaults = getDefaultToolToggles()
  const allToggleIds = new Set<ToggleId>([
    ...CORE_MCP_TOOL_CATALOG.map((tool) => tool.id),
    ...INSTRUCTION_SYNC_TARGET_CATALOG.map((target) => target.id),
  ])

  if (!rawValue || typeof rawValue !== 'object') {
    return defaults
  }

  for (const toggleId of allToggleIds) {
    const value = (rawValue as Record<string, unknown>)[toggleId]
    if (typeof value === 'boolean') {
      defaults[toggleId] = value
    }
  }

  return defaults
}
