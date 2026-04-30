'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BookOpen, FilePenLine, FilePlus2, FileText, Save, Shield, Trash2, X } from 'lucide-react'
import { SYNC_TARGET_LOGOS } from '@/components/brand/client-logos'
import { createClient } from '@/lib/supabase/client'
import {
  AgentInstructionFile,
  AgentInstructionSetWithFiles,
  InstructionSetScope,
} from '@/domains/agent-instruction/types'
import { getProjectInstructionSets } from '@/domains/agent-instruction/queries'
import {
  createInstructionFile,
  createInstructionSet,
  deleteInstructionFile,
  updateInstructionFile,
} from '@/domains/agent-instruction/mutations'
import {
  buildDefaultInstructionDescription,
  buildInstructionTitle,
  InstructionRoutingMode,
  parseInstructionRoutingDocument,
  serializeInstructionRoutingDocument,
} from '@/domains/agent-instruction/instruction-routing'
import { upsertProjectAgentControls } from '@/domains/agent-control/mutations'
import { getProjectAgentControls } from '@/domains/agent-control/queries'
import { ConfirmModal } from './confirm-modal'
import {
  CORE_MCP_TOOL_CATALOG,
  CoreMcpToolId,
  INSTRUCTION_SYNC_TARGET_CATALOG,
  InstructionSyncTargetId,
  ToolToggleMap,
  getDefaultToolToggles,
} from '@/domains/agent-control/types'

type AgentInstructionsModalProps = {
  isOpen: boolean
  onClose: () => void
  projectId: string
}

type AgentSettingsTab = 'global' | 'custom' | 'controls'
const CONTEXT_DOCS_DIR = '.pinksundew/docs/'
const CONTEXT_DOCS_NOTE =
  'Project context documents live in .pinksundew/docs/. Read them before making architectural changes.'
const DEFAULT_INSTRUCTION_FILE_NAME = 'agent-rules.md'
const ROUTING_MODE_OPTIONS: Array<{
  id: InstructionRoutingMode
  label: string
  description: string
}> = [
  {
    id: 'always',
    label: 'Always',
    description: 'Keep this instruction active across every supported environment.',
  },
  {
    id: 'match-files',
    label: 'Match Files',
    description: 'Attach this instruction when matching files or paths are involved.',
  },
  {
    id: 'agent-decides',
    label: 'Agent Decides',
    description: 'Provide a short description so supported agents can pull it in when relevant.',
  },
]

const DEFAULT_AGENT_RULES_CONTENT = `### Task Workflow
If I tell you to look at my tasks or check them out, it means to pull them from the board and start working on them. Work on all tasks unless specified not to.
Only work on in-progress or todo tasks.
Always mark tickets you work on as in progress. When finished, mark them for review, not as completed.
Always check replies for more information.
Signal tickets you are working on as Agent Working.
If you are working on the instructions I have given you in the chat, but that task is not present on my board and doesn't relate to any other tasks on my board, create the ticket yourself and add it to my board.

${CONTEXT_DOCS_NOTE}
`

function isContextDocument(file: Pick<AgentInstructionFile, 'file_name'>) {
  return file.file_name.replace(/\\/g, '/').startsWith(CONTEXT_DOCS_DIR)
}

function getInstructionFileLabel(file: Pick<AgentInstructionFile, 'file_name'>) {
  return isContextDocument(file)
    ? file.file_name.replace(/\\/g, '/').slice(CONTEXT_DOCS_DIR.length)
    : file.file_name
}

function normalizePathSegment(rawValue: string) {
  return rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function ensureMarkdownExtension(fileName: string) {
  return fileName.endsWith('.md') ? fileName : `${fileName}.md`
}

function normalizeInstructionFileName(rawValue: string) {
  const lastSegment = rawValue.trim().replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
  return ensureMarkdownExtension(normalizePathSegment(lastSegment) || DEFAULT_INSTRUCTION_FILE_NAME)
}

function buildContextStoragePath(
  title: string,
  files: AgentInstructionFile[],
  currentFileId?: string | null
) {
  const existingNames = new Set(
    files
      .filter((file) => file.id !== currentFileId)
      .map((file) => file.file_name.replace(/\\/g, '/'))
  )
  const baseName = normalizePathSegment(title) || 'instruction'
  let candidate = `${CONTEXT_DOCS_DIR}${ensureMarkdownExtension(baseName)}`
  let index = 2

  while (existingNames.has(candidate)) {
    candidate = `${CONTEXT_DOCS_DIR}${ensureMarkdownExtension(`${baseName}-${index}`)}`
    index += 1
  }

  return candidate
}

function slugifyInstructionCode(rawValue: string) {
  const slug = rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'instruction-set'
}

function buildInstructionSetCode(rawName: string) {
  const normalizedName = rawName.trim().toLowerCase()
  const baseCode = slugifyInstructionCode(normalizedName)

  let hash = 0
  for (let index = 0; index < normalizedName.length; index += 1) {
    hash = (hash * 31 + normalizedName.charCodeAt(index)) | 0
  }

  const suffix = Math.abs(hash).toString(36).slice(0, 6) || 'set'
  return `${baseCode}-${suffix}`
}

function sortInstructionSets(sets: AgentInstructionSetWithFiles[]) {
  return [...sets].sort((left, right) => {
    if (left.sort_order !== right.sort_order) {
      return left.sort_order - right.sort_order
    }

    return left.name.localeCompare(right.name)
  })
}

export function AgentInstructionsModal({
  isOpen,
  onClose,
  projectId,
}: AgentInstructionsModalProps) {
  const [activeTab, setActiveTab] = useState<AgentSettingsTab>('global')

  const [instructionSets, setInstructionSets] = useState<AgentInstructionSetWithFiles[]>([])
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)

  const [draftContent, setDraftContent] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [routingMode, setRoutingMode] = useState<InstructionRoutingMode>('always')
  const [routingDescription, setRoutingDescription] = useState('')
  const [routingGlobs, setRoutingGlobs] = useState('')
  const [editingFileId, setEditingFileId] = useState<string | null>(null)

  const [allowTaskCompletion, setAllowTaskCompletion] = useState(true)
  const [toolToggles, setToolToggles] = useState<ToolToggleMap>(getDefaultToolToggles())
  const [controlsDirty, setControlsDirty] = useState(false)

  const [instructionErrorMessage, setInstructionErrorMessage] = useState<string | null>(null)
  const [controlsErrorMessage, setControlsErrorMessage] = useState<string | null>(null)
  const [isInstructionLoading, setIsInstructionLoading] = useState(false)
  const [isInstructionDeleteLoading, setIsInstructionDeleteLoading] = useState(false)
  const [instructionFilePendingDelete, setInstructionFilePendingDelete] =
    useState<AgentInstructionFile | null>(null)
  const [isControlsSaving, setIsControlsSaving] = useState(false)
  const [supabase] = useState(() => createClient())
  const isGlobalTab = activeTab === 'global'

  const selectedSet = useMemo(
    () => instructionSets.find((instructionSet) => instructionSet.id === selectedSetId) ?? null,
    [instructionSets, selectedSetId]
  )

  const ruleFiles = useMemo(
    () => selectedSet?.files.filter((file) => !isContextDocument(file)) ?? [],
    [selectedSet]
  )

  const contextFiles = useMemo(
    () => selectedSet?.files.filter(isContextDocument) ?? [],
    [selectedSet]
  )

  const contextFileMeta = useMemo(() => {
    const entries = contextFiles.map((file) => {
      const fallbackTitle = buildInstructionTitle(getInstructionFileLabel(file))
      const parsedDocument = parseInstructionRoutingDocument(file.content, {
        defaultTitle: fallbackTitle,
        defaultDescription: buildDefaultInstructionDescription(fallbackTitle),
      })

      const subtitle =
        parsedDocument.config.mode === 'always'
          ? 'Always on'
          : parsedDocument.config.mode === 'match-files'
            ? parsedDocument.config.globs || 'Match selected files'
            : parsedDocument.config.description || 'Agent decides when relevant'

      return [
        file.id,
        {
          title: parsedDocument.config.title,
          subtitle,
        },
      ] as const
    })

    return new Map(entries)
  }, [contextFiles])

  const selectedFile = useMemo(() => {
    if (!selectedSet) {
      return null
    }

    if (isGlobalTab) {
      return ruleFiles.find((file) => file.id === selectedFileId) ?? ruleFiles[0] ?? null
    }

    return contextFiles.find((file) => file.id === selectedFileId) ?? null
  }, [contextFiles, isGlobalTab, ruleFiles, selectedFileId, selectedSet])

  const fetchInstructionSets = useCallback(async (options?: { selectedSetId?: string | null; selectedFileId?: string | null }) => {
    setInstructionErrorMessage(null)

    try {
      const loadInstructionSets = async (
        nextOptions?: { selectedSetId?: string | null; selectedFileId?: string | null }
      ): Promise<void> => {
        let nextSets = sortInstructionSets(
          await getProjectInstructionSets(supabase, projectId)
        )

        if (nextSets.length === 0) {
          const createdSet = await createInstructionSet(supabase, {
            project_id: projectId,
            name: 'Workspace Standard',
            code: buildInstructionSetCode('workspace-standard'),
            scope: 'global' as InstructionSetScope,
          })

          nextSets = [{ ...createdSet, files: [] }]
        }

        setInstructionSets(nextSets)

        const nextSelectedSetId =
          nextOptions?.selectedSetId && nextSets.some((set) => set.id === nextOptions.selectedSetId)
            ? nextOptions.selectedSetId
            : nextSets[0]?.id ?? null
        setSelectedSetId(nextSelectedSetId)

        const nextSelectedSet = nextSets.find((set) => set.id === nextSelectedSetId) ?? null
        if (!nextSelectedSet) {
          setSelectedFileId(null)
          return
        }

        const nextRuleFiles = nextSelectedSet.files.filter((file) => !isContextDocument(file))
        if (nextRuleFiles.length === 0) {
          const createdFile = await createInstructionFile(supabase, {
            set_id: nextSelectedSet.id,
            file_name: DEFAULT_INSTRUCTION_FILE_NAME,
            content: DEFAULT_AGENT_RULES_CONTENT,
          })

          await loadInstructionSets({
            selectedSetId: nextSelectedSet.id,
            selectedFileId: createdFile.id,
          })
          return
        }

        const nextSelectedFileId =
          nextOptions?.selectedFileId &&
          nextSelectedSet.files.some((file) => file.id === nextOptions.selectedFileId)
            ? nextOptions.selectedFileId
            : nextRuleFiles[0]?.id ?? nextSelectedSet.files[0]?.id ?? null

        setSelectedFileId(nextSelectedFileId)
      }

      await loadInstructionSets(options)
    } catch (error) {
      console.error('Error loading instruction sets:', error)
      setInstructionErrorMessage('Unable to load instruction files right now.')
    }
  }, [projectId, supabase])

  const fetchAgentControls = useCallback(async () => {
    setControlsErrorMessage(null)

    try {
      const controls = await getProjectAgentControls(supabase, projectId)
      setAllowTaskCompletion(controls.allow_task_completion)
      setToolToggles(controls.tool_toggles)
      setControlsDirty(false)
    } catch (error) {
      console.error('Error loading project agent controls:', error)
      setControlsErrorMessage('Unable to load agent controls right now.')
    }
  }, [projectId, supabase])

  useEffect(() => {
    if (!isOpen) {
      setInstructionErrorMessage(null)
      setControlsErrorMessage(null)
      setActiveTab('global')
      return
    }

    void fetchInstructionSets()
    void fetchAgentControls()
  }, [fetchAgentControls, fetchInstructionSets, isOpen])

  useEffect(() => {
    if (!selectedSet) {
      setSelectedFileId(null)
      return
    }

    const visibleFiles = isGlobalTab ? ruleFiles : contextFiles
    if (visibleFiles.length === 0) {
      setSelectedFileId(null)
      return
    }

    if (selectedFileId && visibleFiles.some((file) => file.id === selectedFileId)) {
      return
    }

    setSelectedFileId(visibleFiles[0]?.id ?? null)
  }, [contextFiles, isGlobalTab, ruleFiles, selectedFileId, selectedSet])

  useEffect(() => {
    if (!selectedFile) {
      setDraftContent('')
      setDraftTitle('')
      setRoutingMode('always')
      setRoutingDescription('')
      setRoutingGlobs('')
      setEditingFileId(null)
      return
    }

    if (isGlobalTab) {
      setDraftContent(selectedFile.content)
      setDraftTitle('')
      setRoutingMode('always')
      setRoutingDescription('')
      setRoutingGlobs('')
      setEditingFileId(null)
      return
    }

    const fallbackTitle = buildInstructionTitle(getInstructionFileLabel(selectedFile))
    const parsedDocument = parseInstructionRoutingDocument(selectedFile.content, {
      defaultTitle: fallbackTitle,
      defaultDescription: buildDefaultInstructionDescription(fallbackTitle),
    })

    setDraftContent(parsedDocument.body)
    setDraftTitle(parsedDocument.config.title)
    setRoutingMode(parsedDocument.config.mode)
    setRoutingDescription(parsedDocument.config.description)
    setRoutingGlobs(parsedDocument.config.globs)
  }, [isGlobalTab, selectedFile])

  const handleToggleTool = (toolId: CoreMcpToolId) => {
    setToolToggles((previous) => ({
      ...previous,
      [toolId]: !previous[toolId],
    }))
    setControlsDirty(true)
    setControlsErrorMessage(null)
  }

  const handleToggleSyncTarget = (targetId: InstructionSyncTargetId) => {
    setToolToggles((previous) => ({
      ...previous,
      [targetId]: !previous[targetId],
    }))
    setControlsDirty(true)
    setControlsErrorMessage(null)
  }

  const handleToggleTaskCompletion = () => {
    setAllowTaskCompletion((previous) => !previous)
    setControlsDirty(true)
    setControlsErrorMessage(null)
  }

  const handleSaveControls = async () => {
    setIsControlsSaving(true)
    setControlsErrorMessage(null)

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      const controls = await upsertProjectAgentControls(supabase, {
        project_id: projectId,
        allow_task_completion: allowTaskCompletion,
        tool_toggles: toolToggles,
        updated_by: user?.id ?? null,
      })

      setAllowTaskCompletion(controls.allow_task_completion)
      setToolToggles(controls.tool_toggles)
      setControlsDirty(false)
    } catch (error) {
      console.error('Error saving project agent controls:', error)
      setControlsErrorMessage('Unable to save agent controls right now.')
    } finally {
      setIsControlsSaving(false)
    }
  }

  const handleSaveFile = async () => {
    if (!selectedFile) return

    if (!isGlobalTab && routingMode === 'agent-decides' && !routingDescription.trim()) {
      setInstructionErrorMessage('Add a short description so supported agents know when to use this file.')
      return
    }

    if (!isGlobalTab && routingMode === 'match-files' && !routingGlobs.trim()) {
      setInstructionErrorMessage('Add one or more glob patterns for Match Files mode.')
      return
    }

    setIsInstructionLoading(true)
    setInstructionErrorMessage(null)

    try {
      const content =
        isGlobalTab
          ? draftContent
          : serializeInstructionRoutingDocument(draftContent, {
              title: draftTitle,
              mode: routingMode,
              description: routingDescription,
              globs: routingGlobs,
            })

      await updateInstructionFile(supabase, selectedFile.id, {
        file_name: isGlobalTab
          ? normalizeInstructionFileName(selectedFile.file_name)
          : buildContextStoragePath(draftTitle, selectedSet?.files ?? [], selectedFile.id),
        content,
      })

      await fetchInstructionSets({
        selectedSetId: selectedSet?.id ?? null,
        selectedFileId: selectedFile.id,
      })
      setEditingFileId(null)
    } catch (error) {
      console.error('Error saving instruction file:', error)
      setInstructionErrorMessage('Unable to save that instruction file.')
    } finally {
      setIsInstructionLoading(false)
    }
  }

  const handleAddContextDocument = async () => {
    if (!selectedSet) return

    setIsInstructionLoading(true)
    setInstructionErrorMessage(null)

    try {
      const title = `Instruction ${contextFiles.length + 1}`
      const fileName = buildContextStoragePath(title, selectedSet.files)
      const createdFile = await createInstructionFile(supabase, {
        set_id: selectedSet.id,
        file_name: fileName,
        content: serializeInstructionRoutingDocument(`# ${title}\n\n`, {
          title,
          mode: 'agent-decides',
          description: buildDefaultInstructionDescription(title),
          globs: '',
        }),
      })

      await fetchInstructionSets({
        selectedSetId: selectedSet.id,
        selectedFileId: createdFile.id,
      })
      setEditingFileId(createdFile.id)
    } catch (error) {
      console.error('Error creating context document:', error)
      setInstructionErrorMessage('Unable to create a context document right now.')
    } finally {
      setIsInstructionLoading(false)
    }
  }

  const handleDeleteContextDocument = async () => {
    if (!selectedSet || !instructionFilePendingDelete) return

    setIsInstructionDeleteLoading(true)
    setInstructionErrorMessage(null)

    try {
      const nextSelectedContextFile =
        contextFiles.find((file) => file.id !== instructionFilePendingDelete.id) ?? null

      await deleteInstructionFile(supabase, instructionFilePendingDelete.id)

      await fetchInstructionSets({
        selectedSetId: selectedSet.id,
        selectedFileId: nextSelectedContextFile?.id ?? null,
      })

      setInstructionFilePendingDelete(null)
    } catch (error) {
      console.error('Error deleting context document:', error)
      setInstructionErrorMessage('Unable to delete that context document right now.')
    } finally {
      setIsInstructionDeleteLoading(false)
    }
  }

  const handleSaveAll = async () => {
    const promises = []
    if (selectedFile) promises.push(handleSaveFile())
    if (controlsDirty) promises.push(handleSaveControls())
    await Promise.all(promises)
  }

  const currentInstructionFiles = isGlobalTab ? ruleFiles : contextFiles
  const currentInstructionIcon = isGlobalTab ? FileText : BookOpen
  const currentInstructionTitle = isGlobalTab ? 'Global Agent Rules' : 'Custom Context Files'
  const currentInstructionDescription = isGlobalTab
    ? 'Behavioral rules applied to connected AI sessions.'
    : 'Answer a couple routing questions per file and Pink Sundew maps them across each connected environment.'
  const currentInstructionPlaceholder = isGlobalTab
    ? `# Agent Rules\n\n${CONTEXT_DOCS_NOTE}`
    : '# Architecture\n\nDescribe important domain, data, and product context here.'
  const emptyInstructionState = isGlobalTab
    ? 'Preparing your global instruction file...'
    : 'Create a custom file on the left to start writing context for agents.'
  const CurrentInstructionIcon = currentInstructionIcon

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        />
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="relative flex h-[88vh] max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        >
          <div className="flex items-center justify-between p-4 shrink-0">
            <div>
              <h2 className="text-xl font-semibold">Agent Instructions</h2>
              <p className="text-sm text-muted-foreground">
                Configure global rules, custom context documents, and what MCP agents are allowed
                to do on this board.
              </p>
              <div className="mt-3 inline-flex rounded-lg border border-border bg-muted/20 p-1">
                <button
                  type="button"
                  onClick={() => setActiveTab('global')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                    activeTab === 'global'
                      ? 'bg-white text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Global Instructions
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('custom')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                    activeTab === 'custom'
                      ? 'bg-white text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Custom Instructions
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('controls')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                    activeTab === 'controls'
                      ? 'bg-white text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Agent Controls
                </button>
              </div>
            </div>
            <button onClick={onClose} className="rounded-full p-2 hover:bg-gray-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {activeTab !== 'controls' ? (
            <div className="m-3 flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-inner">
              <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-slate-50/50 p-4">
                {isGlobalTab ? (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      Sync Targets
                    </h3>
                    <p className="mt-1.5 text-xs leading-snug text-slate-500">
                      Toggle the target rules files for connected MCP clients.
                    </p>

                    <div className="mt-3 space-y-1.5">
                      {INSTRUCTION_SYNC_TARGET_CATALOG.map((target) => {
                        const TargetLogo = SYNC_TARGET_LOGOS[target.id]
                        const isEnabled = toolToggles[target.id]

                        return (
                          <button
                            key={target.id}
                            type="button"
                            onClick={() => handleToggleSyncTarget(target.id)}
                            className={`group flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-all ${
                              isEnabled
                                ? 'border-primary/40 bg-white shadow-sm'
                                : 'border-slate-200 bg-white/70 hover:border-primary/20 hover:bg-white'
                            }`}
                          >
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                              {TargetLogo ? (
                                <TargetLogo className="h-5 w-5" />
                              ) : (
                                <FileText className="h-4 w-4 text-slate-500" />
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div
                                className={`text-sm font-semibold leading-tight ${
                                  isEnabled ? 'text-primary' : 'text-slate-700'
                                }`}
                              >
                                {target.name}
                              </div>
                              <div className="truncate font-mono text-[10px] leading-tight text-slate-500">
                                {target.file_path}
                              </div>
                            </div>
                            <div
                              className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                                isEnabled
                                  ? 'bg-primary'
                                  : 'bg-slate-200 group-hover:bg-slate-300'
                              }`}
                            >
                              <span
                                className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
                                  isEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                                }`}
                              />
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      Custom Files
                    </h3>
                    <p className="mt-1.5 text-xs leading-snug text-slate-500">
                      Each file becomes a shared source document that Pink Sundew routes into the
                      right env-specific instruction format for connected tools.
                    </p>
                    <button
                      type="button"
                      onClick={handleAddContextDocument}
                      disabled={!selectedSet || isInstructionLoading}
                      className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FilePlus2 className="h-4 w-4" />
                      New File
                    </button>

                    <div className="mt-4 space-y-1.5">
                      {currentInstructionFiles.length > 0 ? (
                        currentInstructionFiles.map((file) => (
                          <div
                            key={file.id}
                            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors ${
                              selectedFileId === file.id
                                ? 'border-primary/40 bg-primary/10 text-primary-foreground'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-primary/20'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedFileId(file.id)
                                setEditingFileId(null)
                              }}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <BookOpen className="h-4 w-4 shrink-0" />
                              <div className="min-w-0 flex-1">
                                {editingFileId === file.id && selectedFileId === file.id ? (
                                  <input
                                    value={draftTitle}
                                    onChange={(event) => setDraftTitle(event.target.value)}
                                    onBlur={() => setEditingFileId(null)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        setEditingFileId(null)
                                      }

                                      if (event.key === 'Escape') {
                                        event.preventDefault()
                                        setEditingFileId(null)
                                      }
                                    }}
                                    className="w-full rounded bg-white/80 px-1 py-0.5 text-sm font-semibold text-slate-800 outline-none ring-1 ring-primary/30"
                                    aria-label="Instruction title"
                                    autoFocus
                                  />
                                ) : (
                                  <div className="truncate font-semibold text-slate-800">
                                    {contextFileMeta.get(file.id)?.title ?? buildInstructionTitle(getInstructionFileLabel(file))}
                                  </div>
                                )}
                                <div className="truncate text-[11px] font-normal text-slate-500">
                                  {contextFileMeta.get(file.id)?.subtitle ?? 'Custom instruction'}
                                </div>
                              </div>
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                setSelectedFileId(file.id)
                                setEditingFileId(file.id)
                              }}
                              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
                              aria-label={`Rename ${contextFileMeta.get(file.id)?.title ?? 'instruction file'}`}
                            >
                              <FilePenLine className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setInstructionFilePendingDelete(file)}
                              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-rose-600"
                              aria-label={`Delete ${contextFileMeta.get(file.id)?.title ?? 'instruction file'}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-lg border border-dashed border-slate-300 bg-white/60 px-3 py-3 text-xs leading-5 text-slate-500">
                          Create a markdown file to keep architecture, schema, or product context separate from the global rules file.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4 shrink-0">
                  <div className="flex items-center gap-2.5 text-foreground">
                    <CurrentInstructionIcon className="h-5 w-5 text-primary" />
                    <div>
                      <h3 className="font-semibold text-slate-800">{currentInstructionTitle}</h3>
                      <p className="hidden text-xs text-slate-500 sm:block">
                        {currentInstructionDescription}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveAll}
                    disabled={
                      (!selectedFile && !controlsDirty) || isInstructionLoading || isControlsSaving
                    }
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
                  >
                    <Save className="h-4 w-4" />{' '}
                    {isInstructionLoading || isControlsSaving ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>

                <div className="flex min-h-0 flex-1 flex-col bg-slate-50 p-4">
                  {selectedFile ? (
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                      {!isGlobalTab ? (
                        <div className="border-b border-slate-200 bg-slate-50/70 px-4 py-3">
                          <div className="mt-4 rounded-lg border border-pink-200/70 bg-pink-50/60 p-3">
                            <div className="text-xs font-bold uppercase tracking-wider text-slate-700">
                              When Should This Apply?
                            </div>
                            <p className="mt-1 text-xs leading-5 text-slate-500">
                              Pink Sundew uses this once and translates it into the best supported
                              format for each connected environment.
                            </p>

                            <div className="mt-3 flex flex-wrap gap-2">
                              {ROUTING_MODE_OPTIONS.map((option) => (
                                <button
                                  key={option.id}
                                  type="button"
                                  onClick={() => setRoutingMode(option.id)}
                                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                                    routingMode === option.id
                                      ? 'border-primary bg-white text-primary shadow-sm'
                                      : 'border-pink-200 bg-white/70 text-slate-600 hover:border-primary/30 hover:text-slate-800'
                                  }`}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>

                            <p className="mt-2 text-xs text-slate-500">
                              {ROUTING_MODE_OPTIONS.find((option) => option.id === routingMode)
                                ?.description ?? ''}
                            </p>

                            {routingMode === 'agent-decides' ? (
                              <div className="mt-3">
                                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-600">
                                  When Should Agents Pull This In?
                                </label>
                                <input
                                  value={routingDescription}
                                  onChange={(event) => setRoutingDescription(event.target.value)}
                                  placeholder={buildDefaultInstructionDescription(draftTitle)}
                                  className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition-colors focus:border-primary"
                                />
                              </div>
                            ) : null}

                            {routingMode === 'match-files' ? (
                              <div className="mt-3">
                                <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-600">
                                  File Globs
                                </label>
                                <input
                                  value={routingGlobs}
                                  onChange={(event) => setRoutingGlobs(event.target.value)}
                                  placeholder="src/**/*.ts,src/**/*.tsx"
                                  className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none transition-colors focus:border-primary"
                                />
                                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                                  Separate multiple patterns with commas.
                                </p>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      <div className="flex min-h-0 flex-1 overflow-hidden">
                        <textarea
                          value={draftContent}
                          onChange={(event) => setDraftContent(event.target.value)}
                          placeholder={currentInstructionPlaceholder}
                          className="min-h-0 flex-1 resize-none overflow-y-auto bg-white p-5 font-mono text-sm leading-loose text-slate-700 outline-none focus:ring-0"
                        />
                      </div>
                    </div>
                  ) : isGlobalTab ? (
                    <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/50 px-6 text-center text-sm text-slate-500">
                      {emptyInstructionState}
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6">
                      <div className="max-w-md text-center">
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                          <BookOpen className="h-5 w-5" />
                        </div>
                        <h4 className="mt-4 text-base font-semibold text-slate-900">
                          No custom files yet
                        </h4>
                        <p className="mt-2 text-sm leading-6 text-slate-500">
                          Keep architecture notes, product context, and schema docs separate from
                          your global rules file.
                        </p>
                        <button
                          type="button"
                          onClick={handleAddContextDocument}
                          disabled={!selectedSet || isInstructionLoading}
                          className="mt-5 inline-flex items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <FilePlus2 className="h-4 w-4" />
                          Create your first file
                        </button>
                      </div>
                    </div>
                  )}

                  {instructionErrorMessage ? (
                    <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 shadow-sm">
                      {instructionErrorMessage}
                    </div>
                  ) : null}
                  {controlsErrorMessage ? (
                    <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 shadow-sm">
                      {controlsErrorMessage}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="m-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/60 p-4">
                <div className="flex items-start gap-2 text-foreground">
                  <Shield className="mt-0.5 h-5 w-5 text-primary" />
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-[0.08em]">
                      Agent Controls
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Toggle what the MCP agent can do on this board.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleSaveControls}
                  disabled={!controlsDirty || isControlsSaving}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Save className="h-4 w-4" /> {isControlsSaving ? 'Saving...' : 'Save Controls'}
                </button>
              </div>

              <div className="min-h-0 overflow-y-auto p-4">
                <div className="space-y-3">
                  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold text-foreground">Allow Task Completion</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          If enabled, agents can move tickets to Done. Completed tickets are flagged for review.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleToggleTaskCompletion}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                          allowTaskCompletion ? 'bg-primary' : 'bg-slate-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                            allowTaskCompletion ? 'translate-x-5' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {CORE_MCP_TOOL_CATALOG.map((tool) => (
                    <div
                      key={tool.id}
                      className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-foreground">{tool.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{tool.description}</div>
                          <div className="mt-2 font-mono text-[11px] text-muted-foreground">{tool.id}</div>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleToggleTool(tool.id)}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                            toolToggles[tool.id] ? 'bg-primary' : 'bg-slate-300'
                          }`}
                        >
                          <span
                            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                              toolToggles[tool.id] ? 'translate-x-5' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                  ))}

                  {controlsErrorMessage ? (
                    <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                      {controlsErrorMessage}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      <ConfirmModal
        isOpen={instructionFilePendingDelete !== null}
        title="Delete Context File"
        message={
          instructionFilePendingDelete
            ? `Delete "${getInstructionFileLabel(instructionFilePendingDelete)}"? It will stop syncing into ${CONTEXT_DOCS_DIR}.`
            : 'Delete this context file?'
        }
        confirmText={isInstructionDeleteLoading ? 'Deleting...' : 'Delete File'}
        cancelText="Keep File"
        isDestructive
        onConfirm={() => {
          void handleDeleteContextDocument()
        }}
        onClose={() => {
          if (isInstructionDeleteLoading) return
          setInstructionFilePendingDelete(null)
        }}
      />
    </AnimatePresence>
  )
}
