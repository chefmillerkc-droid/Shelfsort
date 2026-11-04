// Page-turn haptics. Fire-and-forget, never throws, never blocks a
// turn: on native, Capacitor Haptics; on web / if the plugin is
// missing, navigator.vibrate if available; otherwise a silent no-op.
// Callers must only call this when a turn actually completes — never
// during a drag, and never on a snap-back / cancelled drag.
import { Haptics, ImpactStyle } from '@capacitor/haptics'

export async function pageTurnHaptic(strength = 'light') {
  try {
    await Haptics.impact({
      style: strength === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light,
    })
    return
  } catch {
    // Plugin unavailable (web, or cap sync did not register it):
    // fall through to the vibrate fallback below.
  }
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(strength === 'medium' ? 20 : 10)
    }
  } catch {
    // No vibration available — silently no-op.
  }
}
