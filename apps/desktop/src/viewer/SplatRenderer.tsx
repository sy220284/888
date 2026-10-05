/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { extend, useThree } from '@react-three/fiber'
import { SplatMesh, SparkRenderer } from '@sparkjsdev/spark'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { ViewerQuality } from './worldViewModel'

const SparkRendererElement = extend(SparkRenderer)
const SplatMeshElement = extend(SplatMesh)
const ignoreRaycast: THREE.Object3D['raycast'] = () => {}

interface Props {
  url: string
  visible?: boolean
  groundPlaneOffset?: number
  flipY?: boolean
  metricScaleFactor?: number
  quality?: ViewerQuality
}

export function SplatRenderer({
  url,
  visible = true,
  groundPlaneOffset = 0,
  flipY = false,
  metricScaleFactor = 1,
  quality = 'high',
}: Props) {
  const renderer = useThree((state) => state.gl)
  const splatRef = useRef<SplatMesh>(null)
  const sparkRef = useRef<SparkRenderer>(null)
  const sparkArgs = useMemo(
    () => ({ renderer, enableLod: true, encodeLinear: quality === 'high' }),
    [renderer, quality],
  )
  const splatArgs = useMemo(() => ({ url }), [url])

  useEffect(() => {
    if (splatRef.current) splatRef.current.raycast = ignoreRaycast
    if (sparkRef.current) sparkRef.current.raycast = ignoreRaycast
  }, [])

  return (
    <SparkRendererElement ref={sparkRef} args={[sparkArgs]} visible={visible}>
      <group
        position={[0, groundPlaneOffset, 0]}
        rotation={[flipY ? Math.PI : 0, 0, 0]}
        scale={metricScaleFactor}
      >
        <SplatMeshElement ref={splatRef} args={[splatArgs]} />
      </group>
    </SparkRendererElement>
  )
}
