'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  DndContext, 
  DragOverlay, 
  closestCorners, 
  pointerWithin,
  rectIntersection,
  useDroppable,
  type Collision,
  type CollisionDetection,
  KeyboardSensor, 
  PointerSensor, 
  useSensor, 
  useSensors, 
  DragStartEvent,
  DragOverEvent,
  DragEndEvent
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { createClient } from '@/lib/supabase/client'
import { TaskWithTags, TaskStatus } from '@/domains/task/types'
import { KanbanColumn } from './column'
import { TaskCard } from './task-card'
import { InlineComposer } from './inline-composer'
import { CreateTaskModal } from '@/components/modals/create-task-modal'
import { deleteTask, persistTaskOrderWithKeepalive } from '@/domains/task/mutations'
import { getProjectTasks } from '@/domains/task/queries'
import { AgentInstructionsModal } from '@/components/modals/agent-instructions-modal'
import { TaskDetailsModal } from '@/components/modals/task-details-modal'
import { TagManagerModal } from '@/components/modals/tag-manager-modal'
import { ExportModal } from '@/components/modals/export-modal'
import { ConfirmModal } from '@/components/modals/confirm-modal'
import { AbyssModal } from '@/components/modals/abyss-modal'
import { ConnectMcpModal } from '@/components/modals/connect-mcp-modal'
import { ProjectSettingsModal } from '@/components/modals/project-settings-modal'
import { OnboardingTour } from '@/components/onboarding/onboarding-tour'
import { FileText, Ghost, Settings, Trash2, X } from 'lucide-react'
import { isVisibleOnBoard, sortTasksByPosition } from '@/domains/task/visibility'
import { DashboardStatusSection } from './dashboard-status-section'
import type { ProjectDashboardStatus } from '@/domains/project/dashboard-status'
import {
  ANONYMOUS_ACTIVE_TASK_LIMIT,
  countActiveAnonymousTasks,
  getAnonymousTaskLimitPrompt,
  isAnonymousTaskLimitMessage,
} from '@/lib/anon-limits'
import { GLOBAL_OVERLAY_EVENT, type GlobalOverlayDetail } from '@/lib/global-overlay'

type KanbanBoardProps = {
  projectId: string
  projectName: string
  initialTasks: TaskWithTags[]
  viewer?: {
    id: string
    isAnonymous: boolean
  } | null
  dashboardStatus?: ProjectDashboardStatus | null
}

const COLUMNS: TaskStatus[] = ['todo', 'in-progress', 'done']
const ABYSS_DROP_ZONE_ID = 'abyss-drop-zone'
const ABYSS_PROXIMITY_PADDING = 112
const BASE_FLOATING_PILL_BOTTOM = 20
const FLOATING_PILL_GAP = 12
const ACTION_PILL_HEIGHT = 48
const SELECTION_PILL_HEIGHT = 56
const TASK_DELETE_ANIMATION_MS = 320

const collisionDetectionStrategy: CollisionDetection = (args) => {
  const abyssContainer = args.droppableContainers.find(
    (container) => container.id === ABYSS_DROP_ZONE_ID
  )

  const abyssRect = abyssContainer
    ? args.droppableRects.get(ABYSS_DROP_ZONE_ID)
    : null

  if (args.pointerCoordinates && abyssContainer && abyssRect) {
    const { x, y } = args.pointerCoordinates
    const isPointerNearAbyss =
      x >= abyssRect.left - ABYSS_PROXIMITY_PADDING &&
      x <= abyssRect.right + ABYSS_PROXIMITY_PADDING &&
      y >= abyssRect.top - ABYSS_PROXIMITY_PADDING &&
      y <= abyssRect.bottom + ABYSS_PROXIMITY_PADDING

    if (isPointerNearAbyss) {
      const proximityCollision: Collision = {
        id: ABYSS_DROP_ZONE_ID,
        data: {
          droppableContainer: abyssContainer,
          value: Number.POSITIVE_INFINITY,
        },
      }

      return [proximityCollision]
    }
  }

  const pointerCollisions = pointerWithin(args)
  const abyssCollision = pointerCollisions.find(
    (collision) => collision.id === ABYSS_DROP_ZONE_ID
  )

  if (abyssCollision) {
    return [abyssCollision]
  }

  const rectCollisions = rectIntersection(args)
  const abyssRectCollision = rectCollisions.find(
    (collision) => collision.id === ABYSS_DROP_ZONE_ID
  )

  if (abyssRectCollision) {
    return [abyssRectCollision]
  }

  return closestCorners(args)
}

type PersistedTaskOrder = Pick<TaskWithTags, 'id' | 'status' | 'position'>

function normalizeVisibleTasks(taskList: TaskWithTags[]) {
  return sortTasksByPosition(taskList.filter((task) => isVisibleOnBoard(task)))
}

function buildTaskSyncSignature(taskList: TaskWithTags[]) {
  return normalizeVisibleTasks(taskList)
    .map((task) => {
      const tagSignature = [...task.tags]
        .map((tag) => tag.id)
        .sort()
        .join(',')

      return [
        task.id,
        task.updated_at,
        task.status,
        String(task.position),
        task.workflow_signal ?? '',
        task.workflow_signal_message ?? '',
        task.agent_lock_until ?? '',
        task.agent_lock_reason ?? '',
        tagSignature,
      ].join('|')
    })
    .join('||')
}

function mergeRealtimeTask(task: Partial<TaskWithTags>, existing?: TaskWithTags | null) {
  return {
    ...existing,
    ...task,
    tags: existing?.tags ?? [],
  } as TaskWithTags
}

function applyStatusSideEffects(task: TaskWithTags, nextStatus: TaskStatus): TaskWithTags {
  if (nextStatus !== 'done' || task.status === 'done') {
    return { ...task, status: nextStatus }
  }

  return {
    ...task,
    status: nextStatus,
    workflow_signal: null,
    workflow_signal_message: null,
    workflow_signal_updated_at: new Date().toISOString(),
    workflow_signal_updated_by: null,
    agent_lock_until: null,
    agent_lock_reason: null,
  }
}

export function KanbanBoard({
  projectId,
  projectName,
  initialTasks,
  viewer = null,
  dashboardStatus = null,
}: KanbanBoardProps) {
  const isAnonymousUser = Boolean(viewer?.isAnonymous)
  const [tasks, setTasks] = useState<TaskWithTags[]>(() =>
    normalizeVisibleTasks(initialTasks)
  )
  const [activeMobileTab, setActiveMobileTab] = useState<TaskStatus>('todo')
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false)
  const [isTagModalOpen, setIsTagModalOpen] = useState(false)
  const [isAgentInstructionsOpen, setIsAgentInstructionsOpen] = useState(false)
  const [isExportModalOpen, setIsExportModalOpen] = useState(false)
  const [isAbyssModalOpen, setIsAbyssModalOpen] = useState(false)
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false)
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false)
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null)
  const [deletingTaskIds, setDeletingTaskIds] = useState<Set<string>>(new Set())
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [selectedTask, setSelectedTask] = useState<TaskWithTags | null>(null)
  const [followUpSourceTask, setFollowUpSourceTask] = useState<Pick<TaskWithTags, 'id' | 'title'> | null>(null)
  const [createModalDraft, setCreateModalDraft] = useState<{
    title: string
    description: string
  } | null>(null)
  const [activeTask, setActiveTask] = useState<TaskWithTags | null>(null)
  const [dragPlaceholderMinHeight, setDragPlaceholderMinHeight] = useState<number | undefined>(
    undefined
  )
  const [isDeleteArmed, setIsDeleteArmed] = useState(false)
  const [authPromptMessage, setAuthPromptMessage] = useState<string | null>(null)
  const [isSettingsMenuOpen, setIsSettingsMenuOpen] = useState(false)
  const [pillAnchorX, setPillAnchorX] = useState<number | null>(null)
  const [pillWidth, setPillWidth] = useState<number | null>(null)
  const [floatingPillBottom, setFloatingPillBottom] = useState(BASE_FLOATING_PILL_BOTTOM)
  const [isGlobalOverlayOpen, setIsGlobalOverlayOpen] = useState(false)
  const [supabase] = useState(() => createClient())
  const tasksRef = useRef<TaskWithTags[]>(normalizeVisibleTasks(initialTasks))
  const dragStartTasksRef = useRef<TaskWithTags[] | null>(null)
  const boardScrollContainerRef = useRef<HTMLDivElement | null>(null)
  const abyssDropElementRef = useRef<HTMLDivElement | null>(null)
  const abyssCtaButtonRef = useRef<HTMLButtonElement | null>(null)
  const settingsMenuRef = useRef<HTMLDivElement | null>(null)
  const isPersistingOrderRef = useRef(false)
  const lastPersistedTasksRef = useRef<TaskWithTags[]>(normalizeVisibleTasks(initialTasks))
  const pendingPersistRef = useRef<{
    tasks: TaskWithTags[]
    payload: PersistedTaskOrder[]
  } | null>(null)
  const isPersistLoopRunningRef = useRef(false)
  const isAutoRefreshRunningRef = useRef(false)
  const isDragOverProcessingRef = useRef(false)
  const dragPreviewFrameRef = useRef<number | null>(null)
  const pendingDragPreviewRef = useRef<TaskWithTags[] | null>(null)

  const isAnyModalOpen =
    isCreateModalOpen ||
    isDetailsModalOpen ||
    isTagModalOpen ||
    isAgentInstructionsOpen ||
    isExportModalOpen ||
    isAbyssModalOpen ||
    isConnectModalOpen ||
    isProjectSettingsOpen ||
    taskToDelete !== null ||
    authPromptMessage !== null ||
    isGlobalOverlayOpen

  const promptForAuth = (message: string) => {
    setAuthPromptMessage(message)
  }

  const redirectToAuth = () => {
    if (typeof window === 'undefined') return
    const nextPath = `${window.location.pathname}${window.location.search}`
    window.location.href = `/login?next=${encodeURIComponent(nextPath)}`
  }

  useEffect(() => {
    const handleGlobalOverlay = (event: Event) => {
      const detail = (event as CustomEvent<GlobalOverlayDetail>).detail
      if (!detail) {
        return
      }

      setIsGlobalOverlayOpen(detail.open)
    }

    window.addEventListener(GLOBAL_OVERLAY_EVENT, handleGlobalOverlay)
    return () => window.removeEventListener(GLOBAL_OVERLAY_EVENT, handleGlobalOverlay)
  }, [])

  useEffect(() => {
    const nextTasks = normalizeVisibleTasks(initialTasks)
    setTasks(nextTasks)
    tasksRef.current = nextTasks
    lastPersistedTasksRef.current = nextTasks
  }, [initialTasks])

  useEffect(() => {
    const channel = supabase.channel(`tasks_${projectId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` }, (payload) => {
        setTasks(prev => {
          let nextTasks = prev

          if (payload.eventType === 'INSERT') {
            const newTask = mergeRealtimeTask(payload.new as Partial<TaskWithTags>)
            if (!isVisibleOnBoard(newTask)) {
              return prev
            }

            if (!prev.find(t => t.id === newTask.id)) {
              nextTasks = normalizeVisibleTasks([...prev, newTask])
            }
          }

          if (payload.eventType === 'UPDATE') {
            const existingTask = prev.find((task) => task.id === payload.new.id)
            const nextTask = mergeRealtimeTask(payload.new as Partial<TaskWithTags>, existingTask)

            if (!isVisibleOnBoard(nextTask)) {
              nextTasks = prev.filter((task) => task.id !== nextTask.id)
            } else if (!existingTask) {
              nextTasks = normalizeVisibleTasks([...prev, nextTask])
            } else {
              nextTasks = normalizeVisibleTasks(
                prev.map((task) => (task.id === nextTask.id ? nextTask : task))
              )
            }
          }

          if (payload.eventType === 'DELETE') {
            nextTasks = prev.filter(t => t.id !== payload.old.id)
          }

          if (!isPersistingOrderRef.current) {
            lastPersistedTasksRef.current = nextTasks
          }

          return nextTasks
        })
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [projectId, supabase])

  useEffect(() => {
    const refreshBoardTasks = async () => {
      if (isAutoRefreshRunningRef.current) {
        return
      }

      if (isPersistingOrderRef.current || dragStartTasksRef.current || activeTask) {
        return
      }

      if (typeof document !== 'undefined' && document.hidden) {
        return
      }

      isAutoRefreshRunningRef.current = true

      try {
        const latestTasks = normalizeVisibleTasks(await getProjectTasks(supabase, projectId))
        const currentSignature = buildTaskSyncSignature(tasksRef.current)
        const latestSignature = buildTaskSyncSignature(latestTasks)

        if (latestSignature === currentSignature) {
          return
        }

        tasksRef.current = latestTasks
        lastPersistedTasksRef.current = latestTasks
        setTasks(latestTasks)

        setSelectedTask((previous) => {
          if (!previous) {
            return previous
          }

          return latestTasks.find((task) => task.id === previous.id) ?? null
        })
      } catch (error) {
        console.error('Error auto-refreshing board tasks:', error)
      } finally {
        isAutoRefreshRunningRef.current = false
      }
    }

    const refreshInterval = window.setInterval(() => {
      void refreshBoardTasks()
    }, 5000)

    return () => {
      window.clearInterval(refreshInterval)
    }
  }, [activeTask, projectId, supabase])

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isPersistingOrderRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  useEffect(() => {
    if (!isAnyModalOpen || typeof document === 'undefined') {
      return
    }

    const body = document.body
    const html = document.documentElement
    const previousBodyOverflow = body.style.overflow
    const previousBodyTouchAction = body.style.touchAction
    const previousBodyOverscrollY = body.style.overscrollBehaviorY
    const previousHtmlOverflow = html.style.overflow
    const previousHtmlOverscrollY = html.style.overscrollBehaviorY

    body.style.overflow = 'hidden'
    body.style.touchAction = 'none'
    body.style.overscrollBehaviorY = 'none'
    html.style.overflow = 'hidden'
    html.style.overscrollBehaviorY = 'none'

    return () => {
      body.style.overflow = previousBodyOverflow
      body.style.touchAction = previousBodyTouchAction
      body.style.overscrollBehaviorY = previousBodyOverscrollY
      html.style.overflow = previousHtmlOverflow
      html.style.overscrollBehaviorY = previousHtmlOverscrollY
    }
  }, [isAnyModalOpen])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const { setNodeRef: setAbyssDropNodeRef } = useDroppable({
    id: ABYSS_DROP_ZONE_ID,
    data: { type: 'AbyssDropZone' },
  })

  const setAbyssDropRefs = useCallback(
    (node: HTMLDivElement | null) => {
      abyssDropElementRef.current = node
      setAbyssDropNodeRef(node)
    },
    [setAbyssDropNodeRef]
  )

  const isPointNearAbyss = useCallback((x: number, y: number) => {
    const abyssRect = abyssDropElementRef.current?.getBoundingClientRect()
    if (!abyssRect) return false

    return (
      x >= abyssRect.left - ABYSS_PROXIMITY_PADDING &&
      x <= abyssRect.right + ABYSS_PROXIMITY_PADDING &&
      y >= abyssRect.top - ABYSS_PROXIMITY_PADDING &&
      y <= abyssRect.bottom + ABYSS_PROXIMITY_PADDING
    )
  }, [])

  const updatePillGeometry = useCallback(() => {
    if (typeof window === 'undefined') return

    const isMobileViewport = window.innerWidth < 768

    const scrollContainer = boardScrollContainerRef.current
    if (!scrollContainer) {
      setPillAnchorX(null)
      setPillWidth(null)
      return
    }

    const targetColumnId = isMobileViewport ? activeMobileTab : 'in-progress'
    const targetColumn = scrollContainer.querySelector<HTMLElement>(
      `[data-board-column="${targetColumnId}"]`
    )

    if (!targetColumn) {
      setPillAnchorX(null)
      setPillWidth(null)
      return
    }

    const columnRect = targetColumn.getBoundingClientRect()
    const nextWidth = Math.max(0, Math.min(columnRect.width, window.innerWidth - 24))
    setPillWidth((previous) => {
      if (previous !== null && Math.abs(previous - nextWidth) < 0.5) {
        return previous
      }

      return nextWidth
    })

    if (isMobileViewport) {
      setPillAnchorX(null)
      return
    }

    const targetCenterX = columnRect.left + columnRect.width / 2

    setPillAnchorX((previous) => {
      if (previous !== null && Math.abs(previous - targetCenterX) < 0.5) {
        return previous
      }

      return targetCenterX
    })
  }, [activeMobileTab])

  const updateFloatingPillBottom = useCallback(() => {
    if (typeof window === 'undefined') return

    const abyssRect = abyssCtaButtonRef.current?.getBoundingClientRect()
    const baseBottom = BASE_FLOATING_PILL_BOTTOM

    if (!abyssRect || abyssRect.bottom <= 0 || abyssRect.top >= window.innerHeight) {
      setFloatingPillBottom(baseBottom)
      return
    }

    const pillHeight = isSelectionMode ? SELECTION_PILL_HEIGHT : ACTION_PILL_HEIGHT
    const pillTopAtBase = window.innerHeight - baseBottom - pillHeight
    const pillBottomAtBase = window.innerHeight - baseBottom

    const hasOverlapAtBase =
      pillTopAtBase < abyssRect.bottom + FLOATING_PILL_GAP &&
      pillBottomAtBase > abyssRect.top - FLOATING_PILL_GAP

    if (!hasOverlapAtBase) {
      setFloatingPillBottom(baseBottom)
      return
    }

    const requiredBottom = window.innerHeight - abyssRect.top + FLOATING_PILL_GAP
    setFloatingPillBottom(Math.max(baseBottom, Math.ceil(requiredBottom)))
  }, [isSelectionMode])

  useEffect(() => {
    updatePillGeometry()

    const handlePillAnchorUpdate = () => {
      updatePillGeometry()
      updateFloatingPillBottom()
    }

    window.addEventListener('resize', handlePillAnchorUpdate)
    window.addEventListener('scroll', handlePillAnchorUpdate, { passive: true })

    const scrollContainer = boardScrollContainerRef.current
    scrollContainer?.addEventListener('scroll', handlePillAnchorUpdate, { passive: true })

    return () => {
      window.removeEventListener('resize', handlePillAnchorUpdate)
      window.removeEventListener('scroll', handlePillAnchorUpdate)
      scrollContainer?.removeEventListener('scroll', handlePillAnchorUpdate)
    }
  }, [updateFloatingPillBottom, updatePillGeometry])

  useEffect(() => {
    updatePillGeometry()
    updateFloatingPillBottom()
  }, [activeTask, isSelectionMode, updateFloatingPillBottom, updatePillGeometry])

  useEffect(() => {
    if (dragStartTasksRef.current) {
      return
    }

    updatePillGeometry()
    updateFloatingPillBottom()
  }, [tasks, updateFloatingPillBottom, updatePillGeometry])

  const dragPlaceholderByTaskId = useMemo(() => {
    if (!activeTask || dragPlaceholderMinHeight === undefined) {
      return undefined
    }

    return new Map<string, number>([[activeTask.id, dragPlaceholderMinHeight]])
  }, [activeTask, dragPlaceholderMinHeight])

  // Click outside handler for settings menu
  useEffect(() => {
    if (!isSettingsMenuOpen) return

    const handleClickOutside = (event: MouseEvent) => {
      if (
        settingsMenuRef.current &&
        !settingsMenuRef.current.contains(event.target as Node)
      ) {
        setIsSettingsMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isSettingsMenuOpen])

  const selectedTasks = tasks.filter((task) => selectedTaskIds.has(task.id))

  const exitSelectionMode = () => {
    setIsSelectionMode(false)
    setSelectedTaskIds(new Set())
  }

  const hideSelectionMode = () => {
    setIsSelectionMode(false)
  }

  const startSelectionMode = () => {
    setIsSelectionMode(true)
    setSelectedTaskIds(new Set())
  }

  const handleTaskClick = (task: TaskWithTags) => {
    if (isSelectionMode) {
      setSelectedTaskIds((prev) => {
        const next = new Set(prev)
        if (next.has(task.id)) {
          next.delete(task.id)
        } else {
          next.add(task.id)
        }
        return next
      })
      return
    }

    setSelectedTask(task)
    setIsDetailsModalOpen(true)
  }

  const openExportModal = () => {
    if (selectedTasks.length === 0) return
    hideSelectionMode()
    setIsExportModalOpen(true)
  }

  const openCreateModal = (
    predecessorTask: Pick<TaskWithTags, 'id' | 'title'> | null = null,
    draft: { title: string; description: string } | null = null
  ) => {
    setFollowUpSourceTask(predecessorTask)
    setCreateModalDraft(draft)
    setIsCreateModalOpen(true)
  }

  const openCreateFromPill = (draft: { title: string; description: string }) => {
    if (anonymousTaskLimitReached) {
      promptForAuth(getAnonymousTaskLimitPrompt())
      return
    }

    openCreateModal(null, draft)
  }

  const createTaskInline = async (taskInput: {
    project_id: string
    title: string
    description: string | null
    status: TaskStatus
    priority: 'low' | 'medium' | 'high'
    position: number
    predecessor_id: string | null
    assignee_id: string | null
    due_date: string | null
  }): Promise<TaskWithTags> => {
    const computedPosition = tasks.filter((t) => t.status === taskInput.status).length

    const newTaskData = {
      ...taskInput,
      position: computedPosition,
    }

    const { createTask: createDbTask } = await import('@/domains/task/mutations')
    try {
      const created = await createDbTask(supabase, newTaskData)
      const newTask: TaskWithTags = { ...created, tags: [] }

      setTasks((prev) => {
        const nextTasks = normalizeVisibleTasks([...prev, newTask])
        tasksRef.current = nextTasks
        lastPersistedTasksRef.current = nextTasks
        return nextTasks
      })

      return newTask
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create task'
      if (isAnonymousTaskLimitMessage(message)) {
        promptForAuth(getAnonymousTaskLimitPrompt())
      }
      throw error
    }
  }

  const handleUpdateTaskTitle = async (taskId: string, title: string) => {
    try {
      const { updateTask } = await import('@/domains/task/mutations')
      await updateTask(supabase, taskId, { title })

      setTasks((prev) => {
        const nextTasks = prev.map((task) =>
          task.id === taskId ? { ...task, title } : task
        )
        tasksRef.current = nextTasks
        lastPersistedTasksRef.current = nextTasks
        return nextTasks
      })
    } catch (error) {
      console.error('Failed to update task title:', error)
    }
  }

  const normalizeTaskPositions = (taskList: TaskWithTags[]) =>
    taskList.map((task, index) => ({ ...task, position: index }))

  const hasOrderChanged = useCallback(
    (before: TaskWithTags[], after: TaskWithTags[]) =>
      before.length !== after.length ||
      before.some((task, index) => {
        const nextTask = after[index]
        return (
          !nextTask ||
          nextTask.id !== task.id ||
          nextTask.status !== task.status ||
          nextTask.position !== task.position
        )
      }),
    []
  )

  const setDeleteArmedIfChanged = useCallback((nextValue: boolean) => {
    setIsDeleteArmed((previous) => (previous === nextValue ? previous : nextValue))
  }, [])

  const cancelScheduledDragPreview = useCallback(() => {
    pendingDragPreviewRef.current = null

    if (dragPreviewFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(dragPreviewFrameRef.current)
      dragPreviewFrameRef.current = null
    }
  }, [])

  const scheduleDragPreview = useCallback(
    (nextTasks: TaskWithTags[]) => {
      pendingDragPreviewRef.current = nextTasks
      tasksRef.current = nextTasks

      if (dragPreviewFrameRef.current !== null || typeof window === 'undefined') {
        return
      }

      dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
        dragPreviewFrameRef.current = null
        const pendingPreview = pendingDragPreviewRef.current
        pendingDragPreviewRef.current = null

        if (!pendingPreview) {
          return
        }

        setTasks((previous) =>
          hasOrderChanged(previous, pendingPreview) ? pendingPreview : previous
        )
      })
    },
    [hasOrderChanged]
  )

  useEffect(() => () => {
    cancelScheduledDragPreview()
  }, [cancelScheduledDragPreview])

  const toPersistedTaskOrder = (taskList: TaskWithTags[]): PersistedTaskOrder[] =>
    taskList.map((task) => ({
      id: task.id,
      status: task.status,
      position: task.position,
    }))

  const flushPersistQueue = async () => {
    if (isPersistLoopRunningRef.current) return

    isPersistLoopRunningRef.current = true
    isPersistingOrderRef.current = true

    try {
      while (pendingPersistRef.current) {
        const nextPersist = pendingPersistRef.current
        pendingPersistRef.current = null

        try {
          await persistTaskOrderWithKeepalive(projectId, nextPersist.payload)
          lastPersistedTasksRef.current = nextPersist.tasks
        } catch {
          if (!pendingPersistRef.current) {
            tasksRef.current = lastPersistedTasksRef.current
            setTasks(lastPersistedTasksRef.current)
          }
        }
      }
    } finally {
      isPersistingOrderRef.current = false
      isPersistLoopRunningRef.current = false
    }
  }

  const queuePersistTaskOrder = (taskList: TaskWithTags[]) => {
    pendingPersistRef.current = {
      tasks: taskList,
      payload: toPersistedTaskOrder(taskList),
    }

    void flushPersistQueue()
  }

  const buildReorderedTasks = (
    taskList: TaskWithTags[],
    activeId: string,
    overId: string,
    overType?: string
  ) => {
    const activeIndex = taskList.findIndex((t) => t.id === activeId)
    if (activeIndex === -1) return null

    const overIndex = taskList.findIndex((t) => t.id === overId)
    const activeTask = taskList[activeIndex]
    let nextStatus = activeTask.status
    let nextIndex = activeIndex

    if (overType === 'Column') {
      nextStatus = overId as TaskStatus
      // If dropping on a column, move to the end of that column
      const tasksInColumn = taskList.filter((t) => t.status === nextStatus && t.id !== activeId)
      if (tasksInColumn.length > 0) {
        // Find global index of the last task in this column
        const lastTaskInColumn = tasksInColumn[tasksInColumn.length - 1]
        nextIndex = taskList.indexOf(lastTaskInColumn)
      } else {
        // Empty column - find where to insert
        // This is complex for a flat array, but simplest is move to end
        nextIndex = taskList.length - 1
      }
    } else if (overType === 'Task') {
      if (overIndex === -1) return null
      const overTask = taskList[overIndex]
      nextStatus = overTask.status
      nextIndex = overIndex
    } else {
      return null
    }

    // Optimization: If status and general position haven't changed, return null to skip state update
    if (activeTask.status === nextStatus && activeIndex === nextIndex) {
      return null
    }

    const reordered = arrayMove(taskList, activeIndex, nextIndex).map((task) =>
      task.id === activeId ? applyStatusSideEffects(task, nextStatus) : task
    )

    return normalizeTaskPositions(reordered)
  }

  const syncDragPlaceholderHeight = useCallback(
    (rectRef: DragStartEvent['active']['rect']) => {
      const initial = rectRef.current?.initial
      const translated = rectRef.current?.translated
      const pick = (value: number | undefined) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 8
          ? Math.ceil(value)
          : undefined

      const height = pick(initial?.height) ?? pick(translated?.height) ?? 128
      setDragPlaceholderMinHeight(height)
    },
    []
  )

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event
    const activeId = String(active.id)

    cancelScheduledDragPreview()
    setDeleteArmedIfChanged(false)
    dragStartTasksRef.current = [...tasksRef.current]
    setActiveTask(tasksRef.current.find((task) => task.id === activeId) || null)
    syncDragPlaceholderHeight(event.active.rect)
    requestAnimationFrame(() => {
      syncDragPlaceholderHeight(event.active.rect)
    })
  }

  const handleDragCancel = () => {
    cancelScheduledDragPreview()
    setActiveTask(null)
    setDragPlaceholderMinHeight(undefined)
    setDeleteArmedIfChanged(false)

    const dragStartTasks = dragStartTasksRef.current
    if (dragStartTasks) {
      tasksRef.current = dragStartTasks
      setTasks(dragStartTasks)
    }

    dragStartTasksRef.current = null
  }

  const handleDragOver = (event: DragOverEvent) => {
    if (isDragOverProcessingRef.current) return
    isDragOverProcessingRef.current = true

    try {
      const { active, over } = event
      const activeId = String(active.id)
      const translatedRect = active.rect.current.translated
      const isNearAbyss = translatedRect
        ? isPointNearAbyss(
            translatedRect.left + translatedRect.width / 2,
            translatedRect.top + translatedRect.height / 2
          )
        : false

      if (!over) {
        setDeleteArmedIfChanged(isNearAbyss)
        return
      }

      const overId = String(over.id)

      const nextDeleteArmed =
        overId === ABYSS_DROP_ZONE_ID || over.data.current?.type === 'AbyssDropZone' || isNearAbyss

      setDeleteArmedIfChanged(nextDeleteArmed)

      if (activeId === overId) return
      if (overId === ABYSS_DROP_ZONE_ID || over.data.current?.type === 'AbyssDropZone') return

      // If active task status hasn't changed AND it's a Column, skip
      const activeTaskInList = tasksRef.current.find(t => t.id === activeId)
      if (over.data.current?.type === 'Column' && activeTaskInList?.status === overId) {
        return
      }

      const preview = buildReorderedTasks(tasksRef.current, activeId, overId, over.data.current?.type)
      if (preview && hasOrderChanged(tasksRef.current, preview)) {
        scheduleDragPreview(preview)
      }
    } finally {
      isDragOverProcessingRef.current = false
    }
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    const activeId = String(active.id)
    const overId = over ? String(over.id) : null
    const overType = over?.data.current?.type
    const translatedRect = active.rect.current.translated
    const droppedNearAbyss = translatedRect
      ? isPointNearAbyss(
          translatedRect.left + translatedRect.width / 2,
          translatedRect.top + translatedRect.height / 2
        )
      : false

    cancelScheduledDragPreview()
    setActiveTask(null)
    setDragPlaceholderMinHeight(undefined)
    setDeleteArmedIfChanged(false)
    const dragStartTasks = dragStartTasksRef.current ?? tasksRef.current
    const currentPreviewTasks = tasksRef.current
    dragStartTasksRef.current = null

    if (droppedNearAbyss) {
      void deleteTaskById(activeId)
      return
    }

    if (!over) {
      setDeleteArmedIfChanged(false)
      // DragOver may have already moved the task visually; persist if changed
      if (hasOrderChanged(dragStartTasks, currentPreviewTasks)) {
        queuePersistTaskOrder(currentPreviewTasks)
      } else {
        tasksRef.current = dragStartTasks
        setTasks(dragStartTasks)
      }
      return
    }

    if (overId === ABYSS_DROP_ZONE_ID || overType === 'AbyssDropZone') {
      void deleteTaskById(activeId)
      return
    }

    if (!overId || activeId === overId) {
      // Even when over matches active, the preview may have a valid cross-column move
      if (hasOrderChanged(dragStartTasks, currentPreviewTasks)) {
        queuePersistTaskOrder(currentPreviewTasks)
      }
      return
    }

    const finalTasks = buildReorderedTasks(dragStartTasks, activeId, overId, overType)
    if (finalTasks && hasOrderChanged(dragStartTasks, finalTasks)) {
      tasksRef.current = finalTasks
      setTasks(finalTasks)
      queuePersistTaskOrder(finalTasks)
    } else if (hasOrderChanged(dragStartTasks, currentPreviewTasks)) {
      // buildReorderedTasks couldn't compute a result, but the DragOver preview
      // already captured the correct state — persist it instead
      queuePersistTaskOrder(currentPreviewTasks)
    }
  }

  useEffect(() => {
    if (!activeTask && isDeleteArmed) {
      setDeleteArmedIfChanged(false)
    }
  }, [activeTask, isDeleteArmed, setDeleteArmedIfChanged])

  const deleteTaskById = async (id: string) => {
    const previousTasks = tasksRef.current
    if (!previousTasks.some((task) => task.id === id)) {
      return
    }

    setDeletingTaskIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, TASK_DELETE_ANIMATION_MS)
    })

    const remainingTasks = normalizeTaskPositions(tasksRef.current.filter((task) => task.id !== id))

    tasksRef.current = remainingTasks
    setTasks(remainingTasks)

    try {
      await deleteTask(supabase, id)
      lastPersistedTasksRef.current = remainingTasks

      if (remainingTasks.length > 0) {
        queuePersistTaskOrder(remainingTasks)
      }
    } catch {
      tasksRef.current = previousTasks
      setTasks(previousTasks)
    } finally {
      setDeletingTaskIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleConfirmDelete = async () => {
    if (!taskToDelete) return

    const id = taskToDelete
    try {
      await deleteTaskById(id)
    } finally {
      setTaskToDelete(null)
    }
  }

  const anonymousTaskLimitReached =
    isAnonymousUser && countActiveAnonymousTasks(tasks) >= ANONYMOUS_ACTIVE_TASK_LIMIT

  const openTourCreateTask = () => {
    openCreateFromPill({
      title: 'Ask an agent to read this task',
      description:
        'Describe the outcome, useful context, and how you want the agent to report progress.',
    })
  }

  const shouldShowActionPill = !isSelectionMode && !isAnyModalOpen
  const shouldShowSelectionPill = isSelectionMode && !isAnyModalOpen

  return (
    <div className="h-full flex flex-col items-start w-full relative">
      <div className="sticky top-0 z-30 mb-4 w-full shrink-0 bg-background/80 py-2 backdrop-blur-sm">
         <div className="flex w-full justify-start xl:justify-center">
           <DashboardStatusSection
             projectId={projectId}
             status={dashboardStatus}
             isSelectionMode={isSelectionMode}
             onOpenConnect={() => setIsConnectModalOpen(true)}
             onOpenInstructions={() => setIsAgentInstructionsOpen(true)}
             onStartExport={startSelectionMode}
             settingsSlot={(
               <div ref={settingsMenuRef} className="relative">
                 <button
                   type="button"
                   onClick={() => setIsSettingsMenuOpen((prev) => !prev)}
                   className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-white text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                   aria-label="Project settings"
                 >
                   <motion.div
                     animate={{ rotate: isSettingsMenuOpen ? 90 : 0 }}
                     transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                   >
                     <Settings className="h-4 w-4" />
                   </motion.div>
                 </button>
                 <AnimatePresence>
                   {isSettingsMenuOpen && (
                     <motion.div
                       initial={{ opacity: 0, scale: 0.95, y: -4 }}
                       animate={{ opacity: 1, scale: 1, y: 0 }}
                       exit={{ opacity: 0, scale: 0.95, y: -4 }}
                       transition={{ duration: 0.15, ease: [0.2, 0.8, 0.2, 1] }}
                       className="absolute left-0 top-full z-50 mt-2 w-56 origin-top-left rounded-lg border border-border bg-white py-2 shadow-xl"
                     >
                       <button
                         type="button"
                         onClick={() => {
                           setIsSettingsMenuOpen(false)
                           setIsAbyssModalOpen(true)
                         }}
                         className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
                       >
                         <Ghost className="h-4 w-4 text-muted-foreground" />
                         View The Abyss
                       </button>
                       <button
                         type="button"
                         onClick={() => {
                           setIsSettingsMenuOpen(false)
                           setIsAgentInstructionsOpen(true)
                         }}
                         className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
                       >
                         <FileText className="h-4 w-4 text-muted-foreground" />
                         Agent Instructions & Controls
                       </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsSettingsMenuOpen(false)
                          setIsProjectSettingsOpen(true)
                        }}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
                      >
                        <Settings className="h-4 w-4 text-muted-foreground" />
                        Project Settings
                      </button>
                     </motion.div>
                   )}
                 </AnimatePresence>
               </div>
             )}
           />
         </div>

         {/* Mobile Tab Bar */}
         <div className="md:hidden mt-3 w-full max-w-full flex items-center justify-between bg-muted/50 p-1 rounded-lg">
           {COLUMNS.map((col) => {
             const count = tasks.filter((t) => t.status === col).length
             const isActive = activeMobileTab === col
             const labels: Record<TaskStatus, string> = {
               todo: 'To Do',
               'in-progress': 'In Progress',
               done: 'Done',
             }
             return (
               <button
                 key={col}
                 type="button"
                 onClick={() => setActiveMobileTab(col)}
                 className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                   isActive
                     ? 'bg-white text-foreground shadow-sm'
                     : 'text-muted-foreground hover:text-foreground'
                 }`}
               >
                 <span>{labels[col]}</span>
                 <span className="opacity-70">({count})</span>
               </button>
             )
           })}
         </div>
      </div>

      {viewer ? (
        <OnboardingTour
          projectId={projectId}
          viewerId={viewer.id}
          isAnonymousUser={isAnonymousUser}
          taskCount={tasks.length}
          isSuspended={isAnyModalOpen}
          onOpenCreateTask={openTourCreateTask}
          onOpenConnect={() => setIsConnectModalOpen(true)}
          onOpenInstructions={() => setIsAgentInstructionsOpen(true)}
        />
      ) : null}
      
      <CreateTaskModal
        isOpen={isCreateModalOpen}
        onClose={() => {
          setIsCreateModalOpen(false)
          setFollowUpSourceTask(null)
          setCreateModalDraft(null)
        }}
        projectId={projectId}
        initialStatus={activeMobileTab}
        initialTitle={createModalDraft?.title ?? ''}
        initialDescription={createModalDraft?.description ?? ''}
        initialPredecessorTask={followUpSourceTask}
        onUpdateTaskTitle={handleUpdateTaskTitle}
        onSuccess={(newTask) => {
          setTasks((prev) => {
            const nextTasks = normalizeVisibleTasks([...prev, newTask])
            tasksRef.current = nextTasks
            lastPersistedTasksRef.current = nextTasks
            return nextTasks
          })
          setFollowUpSourceTask(null)
          setCreateModalDraft(null)
        }}
      />
      
      <div className="flex min-h-0 flex-1 flex-col">
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetectionStrategy}
        autoScroll={false}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={boardScrollContainerRef}
            data-tour-target="task-board"
            className="grid min-h-0 flex-1 w-full grid-cols-1 gap-6 pb-10 overflow-x-hidden md:grid-cols-3 md:items-stretch md:gap-6 md:overflow-x-auto min-viewport-p xl:mx-auto xl:max-w-[calc(3*20rem+3rem)]"
          >
            {COLUMNS.map((columnId) => (
              <KanbanColumn
                key={columnId}
                columnId={columnId}
                isActiveMobile={activeMobileTab === columnId}
                tasks={tasks.filter((t) => t.status === columnId)}
                isSelectionMode={isSelectionMode}
                selectedTaskIds={selectedTaskIds}
                deletingTaskIds={deletingTaskIds}
                dragPlaceholderByTaskId={dragPlaceholderByTaskId}
                onTaskClick={handleTaskClick}
              />
            ))}
          </div>

          <DragOverlay dropAnimation={null}>
            {activeTask && !isSelectionMode ? <TaskCard task={activeTask} isOverlay /> : null}
          </DragOverlay>

          <AnimatePresence mode="wait">
          {shouldShowActionPill ? (
            <motion.div
              key="action-pill"
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 16 }}
              transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
              className="pointer-events-none fixed z-[70] -translate-x-1/2 transition-[bottom] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
              style={{
                left: pillAnchorX !== null ? `${pillAnchorX}px` : '50%',
                bottom: `${floatingPillBottom}px`,
              }}
            >
              <div
                className="relative max-w-[calc(100vw-1.5rem)]"
                style={{ width: pillWidth !== null ? `${pillWidth}px` : 'min(22rem, calc(100vw - 1.5rem))' }}
              >
                <div
                  data-tour-target="quick-add-task"
                  className={`pointer-events-auto transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
                    activeTask ? 'translate-y-1 scale-95 opacity-0' : 'translate-y-0 scale-100 opacity-100'
                  }`}
                >
                  <InlineComposer
                    projectId={projectId}
                    status={activeMobileTab}
                    anonymousTaskLimitReached={anonymousTaskLimitReached}
                    onPromptAuth={promptForAuth}
                    onCreateTask={createTaskInline}
                    onUpdateTaskTitle={handleUpdateTaskTitle}
                    onExpandRequest={openCreateFromPill}
                  />
                </div>

                {/* Keep this droppable mounted full-time so dnd-kit can always measure it. */}
                <div
                  ref={setAbyssDropRefs}
                  className={`absolute inset-0 flex h-12 items-center justify-center gap-2 rounded-full border px-5 text-sm font-semibold transition-all duration-200 ease-out ${
                    activeTask
                      ? isDeleteArmed
                        ? 'pointer-events-auto scale-110 opacity-100 border-rose-600 bg-rose-600 text-white shadow-xl ring-4 ring-rose-300 animate-pulse'
                        : 'pointer-events-auto scale-100 opacity-100 border-slate-200 bg-white/95 text-slate-600 shadow-lg backdrop-blur'
                      : 'pointer-events-none translate-y-1 scale-95 opacity-0 border-transparent bg-transparent text-transparent'
                  }`}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>{isDeleteArmed ? 'Release to delete' : 'Drop here to delete'}</span>
                </div>
              </div>
            </motion.div>
          ) : null}

          {shouldShowSelectionPill ? (
            <motion.div
              key="selection-pill"
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 16 }}
              transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
              className="pointer-events-none fixed z-[70] -translate-x-1/2 transition-[bottom] duration-200 ease-out"
              style={{
                left: pillAnchorX !== null ? `${pillAnchorX}px` : '50%',
                bottom: `${floatingPillBottom}px`,
              }}
            >
              <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur">
                <button
                  type="button"
                  onClick={openExportModal}
                  disabled={selectedTaskIds.size === 0}
                  className={`rounded-full px-5 py-2 text-sm font-semibold transition-colors ${
                    selectedTaskIds.size > 0
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'bg-slate-200 text-slate-500'
                  }`}
                >
                  {selectedTaskIds.size > 0 ? `Export (${selectedTaskIds.size})` : 'Export'}
                </button>
                <button
                  type="button"
                  onClick={exitSelectionMode}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Exit selection mode"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        </div>
      </DndContext>
      </div>

      <button
        ref={abyssCtaButtonRef}
        type="button"
        onClick={() => {
          setIsAbyssModalOpen(true)
        }}
        className="mt-4 hidden w-full shrink-0 items-center justify-between gap-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50/90 px-5 py-4 text-left transition-colors hover:border-slate-400 hover:bg-slate-100 md:flex"
      >
        <div className="flex items-center gap-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm">
            <Ghost className="h-5 w-5" />
          </span>
          <div>
            <div className="text-sm font-semibold text-foreground">Open The Abyss</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Deleted tickets and completed tickets archived after three days live here.
            </div>
          </div>
        </div>
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Restore / Review
        </span>
      </button>
      <TaskDetailsModal
        isOpen={isDetailsModalOpen}
        onClose={() => {
          setIsDetailsModalOpen(false)
          setSelectedTask(null)
        }}
        task={selectedTask}
        onUpdate={(updated) => {
          setSelectedTask(updated)
          setTasks((prev) => {
            if (!isVisibleOnBoard(updated)) {
              const nextTasks = prev.filter((task) => task.id !== updated.id)
              tasksRef.current = nextTasks
              lastPersistedTasksRef.current = nextTasks
              return nextTasks
            }

            const nextTasks = normalizeVisibleTasks(
              prev.some((task) => task.id === updated.id)
                ? prev.map((task) => (task.id === updated.id ? updated : task))
                : [...prev, updated]
            )
            tasksRef.current = nextTasks
            lastPersistedTasksRef.current = nextTasks
            return nextTasks
          })
        }}
        onDelete={(taskId) =>
          setTasks((prev) => {
            const nextTasks = prev.filter((task) => task.id !== taskId)
            tasksRef.current = nextTasks
            lastPersistedTasksRef.current = nextTasks
            return nextTasks
          })}
        onCompleteAndFollowUp={(task) => openCreateModal({ id: task.id, title: task.title })}
      />
      <TagManagerModal
        isOpen={isTagModalOpen}
        onClose={() => setIsTagModalOpen(false)}
        projectId={projectId}
      />
      <AgentInstructionsModal
        isOpen={isAgentInstructionsOpen}
        onClose={() => setIsAgentInstructionsOpen(false)}
        projectId={projectId}
      />
      {isExportModalOpen ? (
        <ExportModal
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          tasks={selectedTasks}
          projectName={projectName}
        />
      ) : null}
      <ConfirmModal
        isOpen={taskToDelete !== null}
        title="Move Task To The Abyss"
        message="This task will be hidden from the board and can be restored later from the abyss."
        confirmText="Move Task"
        isDestructive
        onConfirm={handleConfirmDelete}
        onClose={() => setTaskToDelete(null)}
      />
      <AbyssModal
        isOpen={isAbyssModalOpen}
        onClose={() => setIsAbyssModalOpen(false)}
        projectId={projectId}
      />
      <ConnectMcpModal
        isOpen={isConnectModalOpen}
        onClose={() => setIsConnectModalOpen(false)}
        projectId={projectId}
      />
      <ProjectSettingsModal
        isOpen={isProjectSettingsOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setIsProjectSettingsOpen(false)}
      />
      <ConfirmModal
        isOpen={authPromptMessage !== null}
        title="Save Your Board"
        message={
          authPromptMessage ??
          'Save this guest board to an account so you can keep working without anonymous limits.'
        }
        confirmText="Save Your Board"
        cancelText="Keep Editing"
        onConfirm={redirectToAuth}
        onClose={() => setAuthPromptMessage(null)}
      />
    </div>
  )
}
