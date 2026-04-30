'use client'

import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ComponentType, SVGProps } from 'react'
import {
  Clock3,
  Download,
  FileText,
  PlugZap,
  Radio,
  Settings2,
  Waves,
  type LucideIcon,
} from 'lucide-react'
import type { ProjectDashboardStatus } from '@/domains/project/dashboard-status'
import { getSetupClientLabel, isSetupClient } from '@/domains/setup-token/types'
import { CLIENT_LOGOS, SYNC_TARGET_LOGOS } from '@/components/brand/client-logos'

type DashboardStatusSectionProps = {
  projectId: string
  status?: ProjectDashboardStatus | null
  isSelectionMode: boolean
  settingsSlot: ReactNode
  onOpenConnect: () => void
  onOpenInstructions: () => void
  onStartExport: () => void
}

const STATUS_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const DASHBOARD_REFRESH_INTERVAL_MS = 15_000

type LogoComponent = ComponentType<SVGProps<SVGSVGElement>>
type IconComponent = LucideIcon | LogoComponent

const TARGET_ICONS: Record<string, IconComponent> = SYNC_TARGET_LOGOS

type DashboardMcpClientId = ProjectDashboardStatus['mcp']['activeClients'][number]['id']

const MCP_CLIENT_ICONS: Record<DashboardMcpClientId, IconComponent> = {
  cursor: CLIENT_LOGOS.cursor,
  codex: CLIENT_LOGOS.codex,
  'claude-code': CLIENT_LOGOS['claude-code'],
  antigravity: CLIENT_LOGOS.antigravity,
  vscode: CLIENT_LOGOS.vscode,
  windsurf: CLIENT_LOGOS.windsurf,
}

function formatStatusTime(value: string | null | undefined) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  return STATUS_TIME_FORMATTER.format(date)
}

function formatConnectedClient(value: string | null | undefined) {
  if (!value) {
    return null
  }

  if (isSetupClient(value)) {
    return getSetupClientLabel(value)
  }

  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function handleCardKeyDown(event: KeyboardEvent<HTMLDivElement>, onActivate: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }

  event.preventDefault()
  onActivate()
}

export function DashboardStatusSection({
  projectId,
  status,
  isSelectionMode,
  settingsSlot,
  onOpenConnect,
  onOpenInstructions,
  onStartExport,
}: DashboardStatusSectionProps) {
  const [currentStatus, setCurrentStatus] = useState<ProjectDashboardStatus | null>(
    status ?? null
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setCurrentStatus(status ?? null)
    }, 0)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [status])

  const refreshDashboardStatus = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/dashboard-status`,
        {
          cache: 'no-store',
        }
      )

      if (!response.ok) return

      const nextStatus = (await response.json()) as ProjectDashboardStatus
      setCurrentStatus(nextStatus)
    } catch (error) {
      console.error('Error refreshing dashboard status:', error)
    }
  }, [projectId])

  useEffect(() => {
    const refreshSoon = () => {
      void refreshDashboardStatus()
    }

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshSoon()
      }
    }

    const initialRefresh = window.setTimeout(() => {
      refreshSoon()
    }, 0)
    const interval = window.setInterval(() => {
      refreshSoon()
    }, DASHBOARD_REFRESH_INTERVAL_MS)

    window.addEventListener('focus', refreshSoon)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearTimeout(initialRefresh)
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshSoon)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [refreshDashboardStatus])

  const mcp = currentStatus?.mcp
  const hasConnected = Boolean(mcp?.hasConnected)
  const isActive = Boolean(mcp?.isActive)
  const lastConnected = formatStatusTime(mcp?.lastConnectedAt)
  const lastSync = formatStatusTime(currentStatus?.instructionSync.lastSyncedAt)
  const connectedClient = formatConnectedClient(mcp?.lastSetupClient)
  const activeClients = mcp?.activeClients ?? []
  const enabledTargets =
    currentStatus?.instructionSync.targets.filter((target) => target.enabled) ?? []
  const connectButtonLabel = !hasConnected ? 'Set Up' : isActive ? 'Connected' : 'Reconnect'
  const activeClientSummary =
    activeClients.length === 1 ? '1 environment active' : `${activeClients.length} environments active`
  const enabledTargetSummary =
    enabledTargets.length === 1 ? '1 target enabled' : `${enabledTargets.length} targets enabled`

  return (
    <section className="w-full md:w-[63rem] max-w-full">
      <div className="grid gap-3 min-[520px]:grid-cols-2">
        <div
          role="button"
          tabIndex={0}
          data-tour-target="agent-sync"
          onClick={onOpenConnect}
          onKeyDown={(event) => handleCardKeyDown(event, onOpenConnect)}
          className="cursor-pointer rounded-lg border border-pink-200/70 bg-white p-3 shadow-sm transition-all hover:border-pink-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/25 sm:p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/20 text-primary-foreground md:flex">
                <PlugZap className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">MCP Server</h2>
                <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                  {isActive ? (
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                    </span>
                  ) : (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-slate-300" />
                  )}
                  <span className="truncate font-medium text-foreground">
                    {isActive ? 'Active and connected' : hasConnected ? 'Not currently active' : 'Setup required'}
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onOpenConnect()
              }}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border border-pink-300 bg-pink-100 px-3 text-xs font-semibold text-pink-900 shadow-sm transition-colors hover:bg-pink-200 sm:h-9 sm:px-4 sm:text-sm"
            >
              <Radio className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              {connectButtonLabel}
            </button>
          </div>

          <div className="mt-3 flex min-h-[1.5rem] flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            {isActive && activeClients.length > 0 ? (
              <>
                <div className="hidden flex-wrap items-center gap-1.5 lg:flex">
                  <span className="font-medium text-foreground">Active on</span>
                  {activeClients.map((client) => {
                    const ClientIcon = MCP_CLIENT_ICONS[client.id] ?? Waves

                    return (
                      <span
                        key={client.id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-pink-200 bg-pink-50 px-2 py-0.5 font-medium text-pink-800"
                      >
                        <ClientIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        {client.name}
                      </span>
                    )
                  })}
                </div>
                <span className="font-medium text-foreground lg:hidden">{activeClientSummary}</span>
              </>
            ) : lastConnected ? (
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="h-3.5 w-3.5" />
                Last connected <time suppressHydrationWarning>{lastConnected}</time>
              </span>
            ) : (
              <span>Use Set Up to connect this project.</span>
            )}
            {connectedClient ? (
              <span className="hidden sm:inline">
                {isActive && activeClients.length === 0 ? 'Active via' : 'Last setup via'}{' '}
                {connectedClient}
              </span>
            ) : null}
          </div>
        </div>

        <div
          role="button"
          tabIndex={0}
          data-tour-target="agent-instructions"
          onClick={onOpenInstructions}
          onKeyDown={(event) => handleCardKeyDown(event, onOpenInstructions)}
          className="cursor-pointer rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-all hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/25 sm:p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cyan-50 text-cyan-700 md:flex">
                <FileText className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Agent Instructions</h2>
                <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock3 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {lastSync ? (
                      <>
                        Last sync <time suppressHydrationWarning>{lastSync}</time>
                      </>
                    ) : (
                      'No sync yet'
                    )}
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onOpenInstructions()
              }}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted sm:h-9 sm:px-4 sm:text-sm"
            >
              <Settings2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Manage
            </button>
          </div>

          <div className="mt-3 flex min-h-[1.5rem] flex-wrap items-center gap-2">
            {enabledTargets.length > 0 ? (
              <>
                <div className="hidden flex-wrap gap-1.5 lg:flex">
                  {enabledTargets.map((target) => {
                    const TargetIcon = TARGET_ICONS[target.id] ?? Waves

                    return (
                      <span
                        key={target.id}
                        title={`${target.name} - ${target.filePath}`}
                        aria-label={`${target.name} target enabled`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm"
                      >
                        <TargetIcon className="h-4 w-4" aria-hidden="true" />
                      </span>
                    )
                  })}
                </div>
                <span className="text-xs text-muted-foreground lg:hidden">{enabledTargetSummary}</span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">No targets selected</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">{settingsSlot}</div>
        <button
          type="button"
          onClick={onStartExport}
          disabled={isSelectionMode}
          className={`inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border px-3 text-sm font-semibold transition-colors ${
            isSelectionMode
              ? 'border-rose-200 bg-rose-50 text-rose-700 opacity-70'
              : 'border-border bg-white text-foreground hover:bg-muted'
          }`}
        >
          <Download className="h-4 w-4" />
          Export To Agent
        </button>
      </div>
    </section>
  )
}
