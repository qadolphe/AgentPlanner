'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TaskWithTags } from '@/domains/task/types'
import { Calendar, User, AlignLeft, CheckCircle2, Circle, GripVertical } from 'lucide-react'
import { getMarkdownPlainTextPreview } from '@/components/markdown/markdown-content'

type TaskCardProps = {
  task: TaskWithTags
  isOverlay?: boolean
  isSelected?: boolean
  isDeleting?: boolean
  isSelectionMode?: boolean
  /** Min height for the sortable placeholder while dragging (avoids layout jump). */
  dragPlaceholderMinHeight?: number
  onClick?: (task: TaskWithTags) => void
}

const DEFAULT_DRAG_PLACEHOLDER_MIN_HEIGHT = 128

const PRIORITY_COLORS = {
  low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  high: 'bg-rose-50 text-rose-700 border-rose-200'
}

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

function formatDateLabel(value: string | null) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return DATE_LABEL_FORMATTER.format(date)
}

export function TaskCard({
  task,
  isOverlay,
  isSelected = false,
  isDeleting = false,
  isSelectionMode = false,
  dragPlaceholderMinHeight,
  onClick,
}: TaskCardProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { 
      type: 'Task', 
      id: task.id,
      task 
    },
    disabled: isSelectionMode || isDeleting,
  })

  const style = {
    transition: isDeleting ? undefined : transition,
    transform: isDeleting ? undefined : CSS.Transform.toString(transform),
  }

  const isReadyForReview = task.workflow_signal === 'ready_for_review'
  const isNeedsHelp = task.workflow_signal === 'needs_help'
  const isAgentWorking = task.workflow_signal === 'agent_working'
  const dueDateLabel = formatDateLabel(task.due_date)
  const createdDateLabel = formatDateLabel(task.created_at)
  const descriptionPreview = task.description
    ? getMarkdownPlainTextPreview(task.description)
    : null
  const datePrefix = dueDateLabel ? 'Due' : createdDateLabel ? 'Created' : null
  const visibleDateLabel = dueDateLabel ?? createdDateLabel ?? 'No date'
  const signalClassName = isNeedsHelp
    ? 'task-signal-needs-help'
    : isAgentWorking
      ? 'task-signal-agent-working'
    : isReadyForReview
      ? 'task-signal-ready-for-review'
      : ''

  if (isDragging && !isOverlay) {
    const placeholderMinHeight =
      dragPlaceholderMinHeight ?? DEFAULT_DRAG_PLACEHOLDER_MIN_HEIGHT

    return (
      <div
        ref={setNodeRef}
        style={{ ...style, minHeight: placeholderMinHeight }}
        className="w-full border-2 border-dashed border-primary/50 bg-primary/5 rounded-xl opacity-50"
      />
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onClick?.(task)}
      className={`
        group flex flex-col bg-white border p-4 rounded-xl transition-all shadow-sm
        ${signalClassName}
        ${isSelectionMode ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing border-border hover:border-primary/40 hover:shadow-md'}
        ${isDeleting ? 'pointer-events-none task-delete-card border-rose-300 bg-rose-50/80 shadow-none' : ''}
        ${isSelected 
          ? 'border-rose-300 bg-rose-50/50 ring-2 ring-rose-200/50 shadow-md' 
          : ''}
        ${isOverlay ? 'scale-105 shadow-xl z-50 bg-white/95 cursor-grabbing' : ''}
      `}
    >
      <div className={isDeleting ? 'task-delete-exit' : ''}>
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center gap-2">
          {isSelectionMode ? (
            isSelected ? (
              <CheckCircle2 className="h-4 w-4 text-rose-500" />
            ) : (
              <Circle className="h-4 w-4 text-muted-foreground/50" />
            )
          ) : null}
          <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border ${PRIORITY_COLORS[task.priority]}`}>
            {task.priority}
          </span>
          {isReadyForReview ? (
            <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border border-pink-200 bg-pink-50 text-pink-700">
              Needs Review
            </span>
          ) : null}
          {isNeedsHelp ? (
            <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border border-rose-200 bg-rose-50 text-rose-700">
              Needs Help
            </span>
          ) : null}
          {isAgentWorking ? (
            <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700">
              Agent Working
            </span>
          ) : null}
        </div>
        {!isSelectionMode ? (
          <div className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors p-1 hover:bg-muted rounded">
            <GripVertical className="w-4 h-4" />
          </div>
        ) : null}
      </div>

      <h4 className="text-sm font-semibold text-foreground leading-tight mb-2">
        {task.title}
      </h4>

      {descriptionPreview && (
        <div className="flex items-center gap-1.5 text-muted-foreground mb-3">
          <AlignLeft className="w-3.5 h-3.5" />
          <span className="text-xs truncate max-w-[200px]">{descriptionPreview}</span>
        </div>
      )}

      {isNeedsHelp && task.workflow_signal_message ? (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
          {task.workflow_signal_message}
        </div>
      ) : null}

      {isReadyForReview && task.workflow_signal_message ? (
        <div className="mb-3 rounded-md border border-pink-200 bg-pink-50 px-2.5 py-2 text-xs text-pink-800">
          {task.workflow_signal_message}
        </div>
      ) : null}

      {isAgentWorking && task.workflow_signal_message ? (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
          {task.workflow_signal_message}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5 mb-4">
        {task.tags?.map((tag) => (
          <span 
            key={tag.id} 
            className="text-[10px] px-2 py-0.5 rounded-md text-white font-medium"
            style={{ backgroundColor: tag.color || '#4f46e5' }}
          >
            {tag.name}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Calendar className="w-3.5 h-3.5" />
          <span>{datePrefix ? `${datePrefix} ${visibleDateLabel}` : visibleDateLabel}</span>
        </div>
        
        {task.assignee_id ? (
           <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center border border-primary/30">
              <User className="w-3.5 h-3.5 text-primary" />
           </div>
        ) : (
           <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center border border-border border-dashed">
              <User className="w-3.5 h-3.5 text-muted-foreground/50" />
           </div>
        )}
      </div>
      </div>
    </div>
  )
}
