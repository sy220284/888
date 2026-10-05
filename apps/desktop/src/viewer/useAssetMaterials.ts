/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

export const SHADED_COLOR = new THREE.Color(0xb8b8b8)

export function useAssetMaterials() {
  const materials = useMemo(() => ({
    wireframeMaterial: new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      toneMapped: false,
      fog: false,
    }),
    shadedMaterial: new THREE.MeshStandardMaterial({
      color: SHADED_COLOR,
      roughness: 0.75,
      metalness: 0,
    }),
    wireframeOverlayMaterial: new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      toneMapped: false,
      fog: false,
    }),
  }), [])

  useEffect(() => () => {
    materials.wireframeMaterial.dispose()
    materials.shadedMaterial.dispose()
    materials.wireframeOverlayMaterial.dispose()
  }, [materials])

  return materials
}
