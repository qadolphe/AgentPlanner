export const SETUP_CLIENTS = [
  'cursor',
  'codex',
  'claude-code',
  'antigravity',
  'vscode',
  'windsurf',
] as const

export type SetupClient = (typeof SETUP_CLIENTS)[number]

const SETUP_CLIENT_LABELS: Record<SetupClient, string> = {
  cursor: 'Cursor',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  antigravity: 'Antigravity',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
}

export function isSetupClient(value: unknown): value is SetupClient {
  return typeof value === 'string' && SETUP_CLIENTS.includes(value as SetupClient)
}

export function getSetupClientLabel(client: SetupClient) {
  return SETUP_CLIENT_LABELS[client]
}
