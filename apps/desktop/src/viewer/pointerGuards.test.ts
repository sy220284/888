import { describe, expect, it } from 'vitest'
import { markObjectInteraction, shouldSuppressPointerLock } from './pointerGuards'

describe('pointerGuards', () => {
  it('对象交互后的短窗口内抑制 pointer lock', () => {
    markObjectInteraction(1000)
    expect(shouldSuppressPointerLock(1200)).toBe(true)
    expect(shouldSuppressPointerLock(1401)).toBe(false)
  })
})
