/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { RigidBody } from '@react-three/rapier'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import * as THREE from 'three'

interface Props {
  url: string
  flipY?: boolean
  groundPlaneOffset?: number
  metricScaleFactor?: number
  visible?: boolean
}

export function WorldCollider({
  url,
  flipY = false,
  groundPlaneOffset = 0,
  metricScaleFactor = 1,
  visible = false,
}: Props) {
  const { scene: source } = useGLTF(url)
  const scene = useMemo(() => cloneSkeleton(source), [source])

  useEffect(() => {
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      child.visible = visible
      child.receiveShadow = visible
    })
  }, [scene, visible])

  return (
    <RigidBody
      type="fixed"
      colliders="trimesh"
      rotation={[flipY ? Math.PI : 0, 0, 0]}
      position={[0, groundPlaneOffset, 0]}
      scale={[metricScaleFactor, metricScaleFactor, metricScaleFactor]}
    >
      <primitive object={scene} />
    </RigidBody>
  )
}
