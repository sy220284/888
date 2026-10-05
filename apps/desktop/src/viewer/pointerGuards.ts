/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
const POINTER_LOCK_SUPPRESSION_MS = 300

let lastObjectInteractionAt = Number.NEGATIVE_INFINITY

export function markObjectInteraction(now = performance.now()) {
  lastObjectInteractionAt = now
}

export function shouldSuppressPointerLock(now = performance.now()) {
  return now - lastObjectInteractionAt < POINTER_LOCK_SUPPRESSION_MS
}
