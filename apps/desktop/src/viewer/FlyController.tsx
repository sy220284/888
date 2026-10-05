/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { isEditableTarget } from './isEditableTarget'
import { useCameraGestures } from './useCameraGestures'

export interface FlyControllerHandle { reset: () => void }

interface Props {
  mouseSensitivity?: number
  speed?: number
}

const DEFAULT_POSITION = new THREE.Vector3(0, 1.85, -0.5)
const SHIFT_MULTIPLIER = 3
const SMOOTHING = 0.12
const DOLLY_UNITS_PER_PIXEL = 0.02
const forwardVector = new THREE.Vector3()
const rightVector = new THREE.Vector3()
const upVector = new THREE.Vector3(0, 1, 0)
const moveVector = new THREE.Vector3()
const dollyVector = new THREE.Vector3()
const euler = new THREE.Euler(0, 0, 0, 'YXZ')

export const FlyController = forwardRef<FlyControllerHandle, Props>(
  function FlyController({ mouseSensitivity = 0.002, speed = 6 }, ref) {
    const { camera, gl } = useThree()
    const keys = useRef(new Set<string>())
    const rawYaw = useRef(0)
    const rawPitch = useRef(0)
    const smoothYaw = useRef(0)
    const smoothPitch = useRef(0)

    const reset = useCallback(() => {
      camera.position.copy(DEFAULT_POSITION)
      camera.quaternion.setFromEuler(euler.set(0, 0, 0))
      keys.current.clear()
      rawYaw.current = 0
      rawPitch.current = 0
      smoothYaw.current = 0
      smoothPitch.current = 0
    }, [camera])

    useImperativeHandle(ref, () => ({ reset }), [reset])

    const dolly = useCallback((deltaY: number) => {
      dollyVector.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize()
      camera.position.addScaledVector(dollyVector, -deltaY * DOLLY_UNITS_PER_PIXEL)
    }, [camera])

    const tumble = useCallback((dx: number, dy: number) => {
      rawYaw.current -= dx * mouseSensitivity
      rawPitch.current -= dy * mouseSensitivity
      rawPitch.current = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, rawPitch.current))
    }, [mouseSensitivity])

    useCameraGestures({ domElement: gl.domElement, onDollyPixels: dolly, onTumblePixels: tumble })

    useEffect(() => reset(), [reset])

    useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        if (isEditableTarget(event.target)) {
          keys.current.delete(event.code)
          return
        }
        if (event.type === 'keydown') keys.current.add(event.code)
        else keys.current.delete(event.code)
      }
      window.addEventListener('keydown', onKey)
      window.addEventListener('keyup', onKey)
      return () => {
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('keyup', onKey)
      }
    }, [])

    useFrame((_state, delta) => {
      const smoothing = 1 - Math.pow(1 - SMOOTHING, delta * 60)
      smoothYaw.current += (rawYaw.current - smoothYaw.current) * smoothing
      smoothPitch.current += (rawPitch.current - smoothPitch.current) * smoothing
      camera.quaternion.setFromEuler(euler.set(smoothPitch.current, smoothYaw.current, 0))

      let forward = 0
      let strafe = 0
      let vertical = 0
      const pressed = keys.current
      if (pressed.has('KeyW') || pressed.has('ArrowUp')) forward += 1
      if (pressed.has('KeyS') || pressed.has('ArrowDown')) forward -= 1
      if (pressed.has('KeyA') || pressed.has('ArrowLeft')) strafe -= 1
      if (pressed.has('KeyD') || pressed.has('ArrowRight')) strafe += 1
      if (pressed.has('KeyE')) vertical += 1
      if (pressed.has('KeyQ')) vertical -= 1

      forwardVector.set(0, 0, -1).applyQuaternion(camera.quaternion)
      rightVector.set(1, 0, 0).applyQuaternion(camera.quaternion)
      moveVector.set(0, 0, 0)
        .addScaledVector(forwardVector, forward)
        .addScaledVector(rightVector, strafe)
        .addScaledVector(upVector, vertical)
      if (moveVector.lengthSq() > 1) moveVector.normalize()

      const multiplier = pressed.has('ShiftLeft') || pressed.has('ShiftRight')
        ? SHIFT_MULTIPLIER
        : 1
      camera.position.addScaledVector(moveVector, speed * multiplier * delta)
    })

    return null
  },
)
