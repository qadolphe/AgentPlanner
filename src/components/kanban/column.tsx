'use client'

import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { TaskWithTags, TaskStatus } from '@/domains/task/types'
import { TaskCard } from './task-card'
import { useMemo } from 'react'

type ColumnProps = {
  columnId: TaskStatus
  tasks: TaskWithTags[]
  isSelectionMode?: boolean
  selectedTaskIds?: Set<string>
  deletingTaskIds?: Set<string>
  onTaskClick?: (task: TaskWithTags) => void
  isActiveMobile?: boolean
  /** Passed to the card that is currently being dragged (sortable placeholder height). */
  dragPlaceholderByTaskId?: Map<string, number>
}

const COLUMN_TITLES: Record<TaskStatus, string> = {
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done'
}

export function KanbanColumn({
  columnId,
  tasks,
  isSelectionMode = false,
  selectedTaskIds = new Set<string>(),
  deletingTaskIds = new Set<string>(),
  onTaskClick,
  isActiveMobile = true,
  dragPlaceholderByTaskId,
}: ColumnProps) {
  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks])

  const { setNodeRef } = useDroppable({
    id: columnId,
    data: { 
      type: 'Column', 
      id: columnId,
      columnId 
    },
  })

  return (
    <div
      data-board-column={columnId}
      data-tour-target={columnId === 'done' ? 'completion-signals' : undefined}
      className={`flex-col bg-muted/30 border border-border rounded-lg w-full md:w-80 h-full min-h-0 overflow-hidden shrink-0 transition-colors ${
        isActiveMobile ? 'flex' : 'hidden md:flex'
      }`}
      ref={setNodeRef}
    >
      <div className="flex items-center justify-between p-4 bg-muted/40 border-b border-border shadow-sm">
        <h3 className="font-semibold text-foreground text-sm uppercase tracking-wide">
          {COLUMN_TITLES[columnId]}
        </h3>
        <span className="bg-white border-border text-xs px-2 py-0.5 rounded-full text-muted-foreground font-medium">
          {tasks.length}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                dragPlaceholderMinHeight={dragPlaceholderByTaskId?.get(task.id)}
                isSelected={selectedTaskIds.has(task.id)}
                isDeleting={deletingTaskIds.has(task.id)}
                isSelectionMode={isSelectionMode}
                onClick={onTaskClick}
              />
            ))}
          </SortableContext>
          <div className="min-h-8 flex-1 shrink-0" aria-hidden />
        </div>
      </div>
    </div>
  )
}
