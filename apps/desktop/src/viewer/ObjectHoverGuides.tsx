/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

const AXIS_LENGTH = 0.2

interface Props {
  size: THREE.Vector3 | [number, number, number]
}

function asTuple(size: THREE.Vector3 | [number, number, number]): [number, number, number] {
  return Array.isArray(size) ? size : [size.x, size.y, size.z]
}

function useLineGeometry(positions: number[], colors?: number[]) {
  const geometry = useMemo(() => {
    const next = new THREE.BufferGeometry()
    next.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    if (colors) next.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    return next
  }, [colors, positions])

  useEffect(() => () => geometry.dispose(), [geometry])
  return geometry
}

export function ObjectHoverGuides({ size }: Props) {
  const [width, height, depth] = asTuple(size)
  const halfWidth = Math.max(width, 0.01) / 2
  const halfHeight = Math.max(height, 0.01) / 2
  const halfDepth = Math.max(depth, 0.01) / 2

  const axisGeometry = useLineGeometry([
    0, 0, 0, AXIS_LENGTH, 0, 0,
    0, 0, 0, 0, AXIS_LENGTH, 0,
    0, 0, 0, 0, 0, AXIS_LENGTH,
  ], [
    1, 0.15, 0.15, 1, 0.15, 0.15,
    0.2, 1, 0.2, 0.2, 1, 0.2,
    0.25, 0.5, 1, 0.25, 0.5, 1,
  ])

  const boxGeometry = useLineGeometry([
    -halfWidth, -halfHeight, -halfDepth, halfWidth, -halfHeight, -halfDepth,
    halfWidth, -halfHeight, -halfDepth, halfWidth, -halfHeight, halfDepth,
    halfWidth, -halfHeight, halfDepth, -halfWidth, -halfHeight, halfDepth,
    -halfWidth, -halfHeight, halfDepth, -halfWidth, -halfHeight, -halfDepth,
    -halfWidth, halfHeight, -halfDepth, halfWidth, halfHeight, -halfDepth,
    halfWidth, halfHeight, -halfDepth, halfWidth, halfHeight, halfDepth,
    halfWidth, halfHeight, halfDepth, -halfWidth, halfHeight, halfDepth,
    -halfWidth, halfHeight, halfDepth, -halfWidth, halfHeight, -halfDepth,
    -halfWidth, -halfHeight, -halfDepth, -halfWidth, halfHeight, -halfDepth,
    halfWidth, -halfHeight, -halfDepth, halfWidth, halfHeight, -halfDepth,
    halfWidth, -halfHeight, halfDepth, halfWidth, halfHeight, halfDepth,
    -halfWidth, -halfHeight, halfDepth, -halfWidth, halfHeight, halfDepth,
  ])

  return (
    <group>
      <lineSegments geometry={axisGeometry}>
        <lineBasicMaterial vertexColors depthTest depthWrite toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={boxGeometry} position={[0, halfHeight, 0]}>
        <lineBasicMaterial color={0xffffff} depthTest depthWrite toneMapped={false} />
      </lineSegments>
    </group>
  )
}
