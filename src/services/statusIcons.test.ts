import {describe, expect, it} from 'vitest'
import {
  formatStatusLabel,
  KNOWN_STATUS_ICON_SET,
  LIFECYCLE_STATUS_KEYS,
  STEP_STATUS_ICON,
  iconForStatus,
  isLifecycleStatus,
  type LifecycleStatusIcon,
  type LifecycleStatusKey,
} from './statusIcons'

describe('status icon helpers', () => {
  it('maps lifecycle statuses to their icons regardless of case', () => {
    const map: Record<LifecycleStatusKey, LifecycleStatusIcon> = {
      queued: '⏳',
      running: '🚀',
      done: '✅',
      blocked: '🛑',
      failed: '❌',
    }

    for (const status of LIFECYCLE_STATUS_KEYS) {
      const expectedIcon = map[status]
      expect(iconForStatus(status)).toBe(expectedIcon)
      expect(iconForStatus(status.toUpperCase())).toBe(expectedIcon)
    }
  })

  it('recognizes lifecycle statuses only when they match known keys', () => {
    for (const status of LIFECYCLE_STATUS_KEYS) {
      expect(isLifecycleStatus(status)).toBe(true)
      expect(isLifecycleStatus(status.toUpperCase())).toBe(true)
    }

    expect(isLifecycleStatus('unknown')).toBe(false)
    expect(isLifecycleStatus('')).toBe(false)
  })

  it('falls back to the step status icon for custom statuses', () => {
    const custom = 'step-42'
    expect(iconForStatus(custom)).toBe(STEP_STATUS_ICON)
    expect(isLifecycleStatus(custom)).toBe(false)
  })

  it('keeps the known icon set aligned with exported icons', () => {
    expect(KNOWN_STATUS_ICON_SET.has(STEP_STATUS_ICON)).toBe(true)
    for (const status of LIFECYCLE_STATUS_KEYS) {
      const icon = iconForStatus(status)
      expect(icon).not.toBeNull()
      if (icon) {
        expect(KNOWN_STATUS_ICON_SET.has(icon)).toBe(true)
      }
    }

    expect(KNOWN_STATUS_ICON_SET.size).toBe(new Set(KNOWN_STATUS_ICON_SET).size)
  })

  it('formats status labels for presentation', () => {
    expect(formatStatusLabel('in_progress')).toBe('In Progress')
    expect(formatStatusLabel('queue')).toBe('Queue')
    expect(formatStatusLabel('DONE')).toBe('Done')
    expect(formatStatusLabel('in progress')).toBe('In Progress')
    expect(formatStatusLabel('custom_step_id')).toBe('Custom Step Id')
    expect(formatStatusLabel('step-42')).toBe('Step 42')
    expect(formatStatusLabel('   ')).toBe('')
  })
})
