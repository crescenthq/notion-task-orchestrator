const lifecycleStatusIcons = {
  queued: '⏳',
  in_progress: '🚀',
  needs_input: '💬',
  done: '✅',
  failed: '❌',
} as const

const statusLabelAliases: Record<string, string> = {
  in_progress: 'In Progress',
  needs_input: 'Needs Input',
}

export type LifecycleStatusKey = keyof typeof lifecycleStatusIcons
export type LifecycleStatusIcon =
  (typeof lifecycleStatusIcons)[LifecycleStatusKey]

export const STEP_STATUS_ICON = '🧭'

export const KNOWN_STATUS_ICONS = [
  ...Object.values(lifecycleStatusIcons),
  STEP_STATUS_ICON,
] as const
export const KNOWN_STATUS_ICON_SET: ReadonlySet<
  LifecycleStatusIcon | typeof STEP_STATUS_ICON
> = new Set(KNOWN_STATUS_ICONS)
export const LIFECYCLE_STATUS_KEYS = Object.keys(
  lifecycleStatusIcons,
) as LifecycleStatusKey[]

export function isLifecycleStatus(
  status: string,
): status is LifecycleStatusKey {
  const normalized = status.trim().toLowerCase()
  return normalized in lifecycleStatusIcons
}

export function iconForStatus(
  status: string,
): LifecycleStatusIcon | typeof STEP_STATUS_ICON | null {
  const normalized = status.trim().toLowerCase()
  if (!normalized) return null
  const lifecycleKey =
    normalized === 'running'
      ? 'in_progress'
      : normalized === 'feedback' || normalized === 'blocked'
        ? 'needs_input'
        : normalized
  if (lifecycleKey in lifecycleStatusIcons) {
    return lifecycleStatusIcons[lifecycleKey as LifecycleStatusKey]
  }
  return STEP_STATUS_ICON
}

export function formatStatusLabel(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (!normalized) return ''
  if (normalized in statusLabelAliases) return statusLabelAliases[normalized]

  return normalized
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
