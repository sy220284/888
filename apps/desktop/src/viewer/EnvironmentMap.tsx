/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { useLoader, useThree } from '@react-three/fiber'
import * as THREE from 'three'

export interface EnvironmentMapHandle {
  setIntensity: (amount: number) => void
}

interface Props {
  panoUrl: string
  intensity?: number
}

export const EnvironmentMap = forwardRef<EnvironmentMapHandle, Props>(
  function EnvironmentMap({ panoUrl, intensity = 1 }, ref) {
    const texture = useLoader(THREE.TextureLoader, panoUrl)
    const { scene } = useThree()
    const transitionAmount = useRef(1)

    const applyIntensity = useCallback(() => {
      const value = transitionAmount.current * intensity
      scene.environmentIntensity = value
      scene.backgroundIntensity = value
    }, [intensity, scene])

    useEffect(() => {
      texture.mapping = THREE.EquirectangularReflectionMapping
      texture.colorSpace = THREE.SRGBColorSpace
      scene.environment = texture
      scene.background = texture
      scene.backgroundBlurriness = 1
      scene.environmentRotation = new THREE.Euler(0, Math.PI / 2, 0)
      scene.backgroundRotation = new THREE.Euler(0, Math.PI / 2, 0)
      applyIntensity()
      return () => {
        if (scene.environment === texture) scene.environment = null
        if (scene.background === texture) scene.background = null
      }
    }, [texture, scene, applyIntensity])

    useEffect(() => applyIntensity(), [applyIntensity])

    useImperativeHandle(ref, () => ({
      setIntensity(amount: number) {
        transitionAmount.current = amount
        applyIntensity()
      },
    }), [applyIntensity])

    return null
  },
)
