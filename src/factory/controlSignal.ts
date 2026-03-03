type SignalRecord = Record<PropertyKey, unknown>

export const CONTROL_SIGNAL_BRAND = Symbol.for('notionflow.control')

function isSignalRecord(value: unknown): value is SignalRecord {
  return typeof value === 'object' && value !== null
}

export function hasControlSignalBrand(value: unknown): boolean {
  return isSignalRecord(value) && value[CONTROL_SIGNAL_BRAND] === true
}

export function brandControlSignal<T extends SignalRecord>(signal: T): T {
  if (signal[CONTROL_SIGNAL_BRAND] === true) return signal
  Object.defineProperty(signal, CONTROL_SIGNAL_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  })

  return signal
}
