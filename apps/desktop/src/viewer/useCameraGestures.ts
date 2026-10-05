/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { useEffect } from 'react'

interface Props {
  domElement: HTMLElement
  onDollyPixels: (delta: number) => void
  onTumblePixels: (dx: number, dy: number) => void
}

export function useCameraGestures({ domElement, onDollyPixels, onTumblePixels }: Props) {
  useEffect(() => {
    let rightDragging = false
    let lastMouseX = 0
    let lastMouseY = 0
    let twoFingerActive = false
    let lastPinchDist = 0
    let lastTouchX = 0
    let lastTouchY = 0

    const onContextMenu = (event: MouseEvent) => event.preventDefault()
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return
      rightDragging = true
      lastMouseX = event.clientX
      lastMouseY = event.clientY
      event.preventDefault()
    }
    const onMouseMove = (event: MouseEvent) => {
      if (!rightDragging || document.pointerLockElement === domElement) return
      const dx = event.clientX - lastMouseX
      const dy = event.clientY - lastMouseY
      lastMouseX = event.clientX
      lastMouseY = event.clientY
      onTumblePixels(dx, dy)
    }
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 2) rightDragging = false
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey) onDollyPixels(event.deltaY)
      else if (event.deltaMode === 0) onTumblePixels(-event.deltaX, -event.deltaY)
      else onDollyPixels(event.deltaY)
    }
    const touchDist = (t: TouchList) =>
      Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY)
    const touchCenter = (t: TouchList) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    })
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        twoFingerActive = false
        return
      }
      twoFingerActive = true
      lastPinchDist = touchDist(event.touches)
      const center = touchCenter(event.touches)
      lastTouchX = center.x
      lastTouchY = center.y
    }
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        twoFingerActive = false
        return
      }
      event.preventDefault()
      const distance = touchDist(event.touches)
      const center = touchCenter(event.touches)
      if (twoFingerActive) {
        const dx = center.x - lastTouchX
        const dy = center.y - lastTouchY
        const centerMove = Math.hypot(dx, dy)
        const pinchDelta = lastPinchDist - distance
        if (centerMove > 0.2) onTumblePixels(-dx, -dy)
        else if (Math.abs(pinchDelta) > 4) onDollyPixels(pinchDelta * 2.5)
      }
      lastPinchDist = distance
      lastTouchX = center.x
      lastTouchY = center.y
      twoFingerActive = true
    }
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) twoFingerActive = false
    }

    domElement.addEventListener('contextmenu', onContextMenu)
    domElement.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    domElement.addEventListener('wheel', onWheel, { passive: false })
    domElement.addEventListener('touchstart', onTouchStart, { passive: true })
    domElement.addEventListener('touchmove', onTouchMove, { passive: false })
    domElement.addEventListener('touchend', onTouchEnd)
    domElement.addEventListener('touchcancel', onTouchEnd)

    return () => {
      domElement.removeEventListener('contextmenu', onContextMenu)
      domElement.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      domElement.removeEventListener('wheel', onWheel)
      domElement.removeEventListener('touchstart', onTouchStart)
      domElement.removeEventListener('touchmove', onTouchMove)
      domElement.removeEventListener('touchend', onTouchEnd)
      domElement.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [domElement, onDollyPixels, onTumblePixels])
}
