'use client'

import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy, KeyRound, Loader2, PlugZap, ShieldCheck, Sparkles, X, Terminal } from 'lucide-react'
import type { SetupClient } from '@/domains/setup-token/types'

type ConnectMcpModalProps = {
  isOpen: boolean
  onClose: () => void
  projectId: string
}

type GuideId = SetupClient

type Snippet = {
  id: string
  label: string
  language: string
  code: string
  setupClient?: SetupClient
}

type Guide = {
  id: GuideId
  label: string
  title: string
  description: string
  steps: string[]
  getSnippets: (config: SnippetConfig) => Snippet[]
}

type SnippetConfig = {
  projectId: string
  setupCommands: Partial<Record<SetupClient, string>>
}

type CodeSnippetCardProps = {
  snippet: Snippet
  copiedSnippetId: string | null
  generatingSnippetId: string | null
  onCopy: (snippet: Snippet) => void
}

function buildSetupCommand(client: SetupClient, token: string, projectId: string) {
  return `pinksundew-mcp setup --token ${token} --client ${client} --project ${projectId}`
}

function placeholderSetupCommand(client: SetupClient, projectId: string) {
  return buildSetupCommand(client, 'pst_generated_on_copy', projectId)
}

function CodeSnippetCard({
  snippet,
  copiedSnippetId,
  generatingSnippetId,
  onCopy,
}: CodeSnippetCardProps) {
  const isCopied = copiedSnippetId === snippet.id
  const isGenerating = generatingSnippetId === snippet.id

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-white">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {snippet.label}
          </span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            {snippet.language}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onCopy(snippet)}
          disabled={isGenerating}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
        >
          {isGenerating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Creating
            </>
          ) : isCopied ? (
            <>
              <Check className="h-3.5 w-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto bg-muted/20 p-3 text-xs leading-relaxed text-foreground">
        <code>{snippet.code}</code>
      </pre>
    </div>
  )
}

function createGuides(): Record<GuideId, Guide> {
  const setupSnippet = (client: SetupClient, config: SnippetConfig): Snippet => ({
    id: `${client}-setup-command`,
    label: 'Setup command',
    language: 'bash',
    setupClient: client,
    code: config.setupCommands[client] ?? placeholderSetupCommand(client, config.projectId),
  })

  return {
    cursor: {
      id: 'cursor',
      label: 'Cursor',
      title: 'Connect Cursor',
      description:
        'Register Pink Sundew in this workspace, link the repo, and sync managed Cursor project rules.',
      steps: [
        'Install the Pink Sundew CLI once on your machine.',
        'Copy the setup command and run it from your repo root.',
        'Restart Cursor or reconnect MCP, then ask it to view your tasks.',
      ],
      getSnippets: (config) => [setupSnippet('cursor', config)],
    },
    codex: {
      id: 'codex',
      label: 'Codex',
      title: 'Connect Codex',
      description:
        'Register one global Codex MCP server while keeping the project link local to this repo.',
      steps: [
        'Install the Pink Sundew CLI once on your machine.',
        'Copy the setup command and run it from your repo root.',
        'Open Codex in this repo and ask it to view your tasks.',
      ],
      getSnippets: (config) => [setupSnippet('codex', config)],
    },
    'claude-code': {
      id: 'claude-code',
      label: 'Claude Code',
      title: 'Connect Claude Code',
      description:
        'Create a project MCP config and link this directory to the selected Pink Sundew project.',
      steps: [
        'Install the Pink Sundew CLI once on your machine.',
        'Copy the setup command and run it from your repo root.',
        'In Claude Code, run /mcp to verify Pink Sundew tools are connected.',
      ],
      getSnippets: (config) => [setupSnippet('claude-code', config)],
    },
    antigravity: {
      id: 'antigravity',
      label: 'Antigravity',
      title: 'Connect Antigravity',
      description:
        'Create a project MCP config and sync Antigravity instructions for this workspace.',
      steps: [
        'Install the Pink Sundew CLI once on your machine.',
        'Copy the setup command and run it from your repo root.',
        'Reconnect the workspace and confirm Pink Sundew tools appear.',
      ],
      getSnippets: (config) => [setupSnippet('antigravity', config)],
    },
    vscode: {
      id: 'vscode',
      label: 'VS Code',
      title: 'Connect VS Code',
      description:
        'Register the MCP server in `.vscode/mcp.json` and sync Copilot instructions for this project.',
      steps: [
        'Install the Pink Sundew CLI once on your machine.',
        'Copy the setup command and run it from your repo root.',
        'Reload VS Code and confirm Pink Sundew MCP tools appear.',
      ],
      getSnippets: (config) => [setupSnippet('vscode', config)],
    },
    windsurf: {
      id: 'windsurf',
      label: 'Windsurf',
      title: 'Connect Windsurf',
      description:
        'Register the MCP server in `~/.codeium/windsurf/mcp_config.json` and sync Windsurf workspace rules for this project.',
      steps: [
        'Install the Pink Sundew CLI once on your machine.',
        'Copy the setup command and run it from your repo root.',
        'Refresh MCP servers in Windsurf and confirm Pink Sundew tools appear.',
      ],
      getSnippets: (config) => [setupSnippet('windsurf', config)],
    },
  }
}

export function ConnectMcpModal({ isOpen, onClose, projectId }: ConnectMcpModalProps) {
  const [activeTab, setActiveTab] = useState<'setup' | 'architecture'>('setup')
  const [activeGuideId, setActiveGuideId] = useState<GuideId>('codex')
  const [copiedSnippetId, setCopiedSnippetId] = useState<string | null>(null)
  const [generatingSnippetId, setGeneratingSnippetId] = useState<string | null>(null)
  const [setupCommands, setSetupCommands] = useState<Partial<Record<SetupClient, string>>>({})
  const [copyError, setCopyError] = useState<string | null>(null)

  const guides = useMemo(() => createGuides(), [])

  useEffect(() => {
    if (!isOpen) {
      setCopiedSnippetId(null)
      setGeneratingSnippetId(null)
      setSetupCommands({})
      setCopyError(null)
      setActiveGuideId('codex')
      setActiveTab('setup')
    }
  }, [isOpen])

  const snippetConfig: SnippetConfig = {
    projectId,
    setupCommands,
  }

  const activeGuide = guides[activeGuideId]
  const snippets = activeGuide.getSnippets(snippetConfig)
  const installSnippets: Snippet[] = [
    {
      id: 'install-brew',
      label: 'Option A: Homebrew',
      language: 'bash',
      code: 'brew install pinksundew/tap/pinksundew-mcp',
    },
    {
      id: 'install-curl',
      label: 'Option B: curl installer',
      language: 'bash',
      code: "curl --proto '=https' --tlsv1.2 -LsSf https://github.com/pinksundew/pinksundew/releases/latest/download/pinksundew-mcp-installer.sh | sh",
    },
  ]

  const createSetupCommand = async (client: SetupClient) => {
    const response = await fetch('/api/setup-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, client }),
    })

    if (!response.ok) {
      throw new Error('Could not create setup token')
    }

    const data = await response.json()
    const token = typeof data.token === 'string' ? data.token : ''
    if (!token.startsWith('pst_')) {
      throw new Error('Setup token response was invalid')
    }

    const command = buildSetupCommand(client, token, projectId)
    setSetupCommands((current) => ({
      ...current,
      [client]: command,
    }))
    return command
  }

  const copySnippet = async (snippet: Snippet) => {
    setCopyError(null)
    setGeneratingSnippetId(snippet.id)
    try {
      const content = snippet.setupClient
        ? await createSetupCommand(snippet.setupClient)
        : snippet.code

      await navigator.clipboard.writeText(content)
      setCopiedSnippetId(snippet.id)
      window.setTimeout(() => {
        setCopiedSnippetId((current) => (current === snippet.id ? null : current))
      }, 1500)
    } catch (error) {
      console.error('Failed to copy setup snippet:', error)
      setCopyError(
        error instanceof Error
          ? error.message
          : 'Could not create a setup command. Please try again.'
      )
    } finally {
      setGeneratingSnippetId(null)
    }
  }

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
          className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        >
          <div className="flex shrink-0 items-center justify-between p-4">
            <div>
              <h2 className="text-xl font-semibold">Connect MCP Server</h2>
              <p className="text-sm text-muted-foreground">
                Install the CLI, then run one setup command from your repo.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 hover:bg-gray-100"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="m-3 grid min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/40 md:m-4 md:grid-cols-[minmax(250px,280px)_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col border-b border-slate-200 bg-white p-4 md:border-b-0 md:border-r">
              <div className="mb-4 flex space-x-1 rounded-lg bg-slate-100 p-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setActiveTab('setup')}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    activeTab === 'setup'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  Setup Guide
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('architecture')}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    activeTab === 'architecture'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  Architecture
                </button>
              </div>

              {activeTab === 'setup' ? (
              <div className="space-y-4 overflow-y-auto pr-1">
                <div className="rounded-2xl border border-pink-200 bg-pink-50 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-pink-950">
                    <Sparkles className="h-4 w-4" />
                    Two-step setup
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-pink-900">
                    The copied command uses a short-lived setup token. Your API key is created only
                    when the CLI exchanges that token, so it never appears in browser snippets.
                  </p>
                </div>

                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    What gets configured
                  </div>
                  <ul className="space-y-2 text-xs text-slate-700">
                    <li>Global auth is saved on this machine.</li>
                    <li>The selected MCP client is registered without secrets.</li>
                    <li>This repo is linked through `.pinksundew/project.json`.</li>
                    <li>The matching instruction sync target is enabled automatically.</li>
                  </ul>
                </div>

                <div className="border-t border-border pt-4">
                  <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    <KeyRound className="h-3.5 w-3.5" />
                    Project ID
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border bg-white px-2 py-1.5">
                    <code className="flex-1 truncate font-mono text-[10px] text-muted-foreground">
                      {projectId}
                    </code>
                    <button
                      type="button"
                      onClick={() =>
                        copySnippet({
                          id: 'project-id',
                          label: 'Project ID',
                          language: 'text',
                          code: projectId,
                        })
                      }
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
                    >
                      {copiedSnippetId === 'project-id' ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
              ) : (
                <div className="space-y-4 overflow-y-auto pr-1">
                  <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-blue-950">
                      <Terminal className="h-4 w-4" />
                      For Power Users
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-blue-900">
                      Understand how the MCP server operates under the hood and how to use the raw CLI commands.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-col overflow-hidden bg-white">
              {activeTab === 'setup' ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mb-3">
                  <h3 className="text-base font-semibold text-foreground">
                    Step 1: Install the MCP CLI
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Do this once on your machine.
                  </p>
                </div>

                <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="space-y-3">
                    {installSnippets.map((snippet) => (
                      <CodeSnippetCard
                        key={snippet.id}
                        snippet={snippet}
                        copiedSnippetId={copiedSnippetId}
                        generatingSnippetId={generatingSnippetId}
                        onCopy={copySnippet}
                      />
                    ))}
                  </div>
                </div>

                <div className="mb-3">
                  <h3 className="text-base font-semibold text-foreground">
                    Step 2: Choose your client
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Copy the setup command, then run it from your repo root.
                  </p>
                </div>

                <div className="mb-4 overflow-x-auto">
                  <div className="inline-flex min-w-max rounded-lg border border-border bg-muted/20 p-1">
                    {(Object.values(guides) as Guide[]).map((guide) => (
                      <button
                        key={guide.id}
                        type="button"
                        onClick={() => setActiveGuideId(guide.id)}
                        className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                          activeGuideId === guide.id
                            ? 'bg-white text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {guide.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mb-3">
                  <h3 className="text-base font-semibold text-foreground">{activeGuide.title}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {activeGuide.description}
                  </p>
                </div>

                <ol className="mb-4 list-decimal space-y-1 pl-4 text-xs text-foreground">
                  {activeGuide.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>

                <div className="space-y-3">
                  {snippets.map((snippet) => (
                    <CodeSnippetCard
                      key={snippet.id}
                      snippet={snippet}
                      copiedSnippetId={copiedSnippetId}
                      generatingSnippetId={generatingSnippetId}
                      onCopy={copySnippet}
                    />
                  ))}
                </div>

                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
                  <PlugZap className="mr-1 inline-block h-3.5 w-3.5" />
                  Setup tokens expire after 10 minutes and can only be used once. If a command
                  expires, copy a fresh one from this modal.
                </div>

                {copyError ? (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
                    {copyError}
                  </div>
                ) : null}
              </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
                  <div className="mx-auto max-w-2xl space-y-6 text-sm text-foreground">
                    <div>
                      <h3 className="text-lg font-semibold mb-2">MCP System Architecture</h3>
                      <p className="text-muted-foreground leading-relaxed">The Pink Sundew MCP server runs locally as a native Rust binary. It separates global authentication from per-repo links to keep workspace files safe.</p>
                    </div>
                    
                    <div className="space-y-3">
                      <strong className="text-sm">Storage Layer</strong>
                      <ul className="list-disc pl-5 space-y-2 text-muted-foreground text-xs leading-relaxed">
                        <li><strong>Global Auth:</strong> Saved securely on your machine in a system app data directory (e.g. <code>~/.config/pinksundew-mcp/auth.json</code>).</li>
                        <li><strong>Workspace Link:</strong> Stored locally in your repo at <code>.pinksundew/project.json</code>.</li>
                        <li><strong>Client Output:</strong> Generates standalone execution blocks in <code>.mcp.json</code> or <code>.vscode/mcp.json</code> containing no raw API keys.</li>
                      </ul>
                    </div>
                    
                    <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                      <div className="font-semibold text-red-900 flex items-center gap-2 mb-1">
                        <ShieldCheck className="h-4 w-4" />
                        Important Security Rule
                      </div>
                      <p className="text-red-800 text-xs leading-relaxed">
                        ⚠️ Do not manually write auth files. Run the setup command instead. The new design explicitly prevents agents and IDEs from accessing your raw API key in workspace configurations.
                      </p>
                    </div>

                    <div className="space-y-3">
                      <strong className="text-sm">CLI Commands</strong>
                      <div className="space-y-2 border border-slate-200 rounded-xl overflow-hidden bg-slate-50/50 text-xs">
                        <div className="p-3 border-b border-slate-200"><code className="font-semibold text-slate-800 mr-2">init</code> Interactive first-time setup wizard.</div>
                        <div className="p-3 border-b border-slate-200"><code className="font-semibold text-slate-800 mr-2">setup</code> Automated web-to-CLI handshake via token.</div>
                        <div className="p-3 border-b border-slate-200"><code className="font-semibold text-slate-800 mr-2">link</code> Binds existing global auth to another project. Only run this if auth already exists globally.</div>
                        <div className="p-3"><code className="font-semibold text-slate-800 mr-2">status</code> Diagnose current authentication and MCP registration status.</div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <strong className="text-sm">Updating With Homebrew</strong>
                      <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 text-xs text-slate-700">
                        <p className="leading-relaxed">
                          If you installed the MCP server with Homebrew, update it with:
                        </p>
                        <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-900">
                          <code>brew upgrade pinksundew/tap/pinksundew-mcp</code>
                        </pre>
                        <p className="mt-3 leading-relaxed text-slate-600">
                          After upgrading, restart your IDE or reconnect MCP so the client launches
                          the newest binary.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  )
}
