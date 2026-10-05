import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Physics } from '@react-three/rapier'
import { AudioManager } from './AudioManager'
import { EnvironmentMap } from './EnvironmentMap'
import { FlyController } from './FlyController'
import { GroundPlane } from './GroundPlane'
import { OptionalAssetBoundary } from './OptionalAssetBoundary'
import { SplatRenderer } from './SplatRenderer'
import { WorldCollider } from './WorldCollider'
import { normalizeWorldViewModel, type ViewerQuality, type WorldViewModel } from './worldViewModel'

interface Props {
  world: WorldViewModel
  quality?: ViewerQuality
  muted?: boolean
}

function EmptyWorld() {
  return (
    <>
      <color attach="background" args={['#202225']} />
      <ambientLight intensity={1.2} />
      <gridHelper args={[40, 40]} />
    </>
  )
}

export function WorldViewer({ world: input, quality = 'high', muted = false }: Props) {
  const world = normalizeWorldViewModel(input)
  const hasWorldAsset = Boolean(world.splatUrl || world.colliderUrl || world.panoUrl)

  return (
    <Canvas
      camera={{ fov: 75, near: 0.05, far: 2000 }}
      gl={{ antialias: quality === 'high' }}
      shadows={quality === 'high'}
    >
      <Suspense fallback={null}>
        {!hasWorldAsset && <EmptyWorld />}
        {!world.panoUrl && hasWorldAsset && <color attach="background" args={['#6b7280']} />}

        {world.panoUrl && (
          <OptionalAssetBoundary label={world.panoUrl} resetKey={world.panoUrl}>
            <EnvironmentMap panoUrl={world.panoUrl} intensity={1} />
          </OptionalAssetBoundary>
        )}

        <ambientLight intensity={0.35} />
        <directionalLight
          castShadow={quality === 'high'}
          intensity={1.3}
          position={[8, 12, 6]}
        />

        <Physics gravity={[0, -9.81, 0]}>
          <FlyController />
          <GroundPlane visible={!world.colliderUrl && !world.splatUrl} />
          {world.colliderUrl && (
            <OptionalAssetBoundary label={world.colliderUrl} resetKey={world.colliderUrl}>
              <WorldCollider
                url={world.colliderUrl}
                flipY={world.flipY}
                groundPlaneOffset={world.groundPlaneOffset}
                metricScaleFactor={world.metricScaleFactor}
                visible={!world.splatUrl}
              />
            </OptionalAssetBoundary>
          )}
        </Physics>

        {world.splatUrl && (
          <OptionalAssetBoundary label={world.splatUrl} resetKey={world.splatUrl}>
            <SplatRenderer
              url={world.splatUrl}
              quality={quality}
              flipY={world.flipY}
              groundPlaneOffset={world.groundPlaneOffset}
              metricScaleFactor={world.metricScaleFactor}
            />
          </OptionalAssetBoundary>
        )}

        <AudioManager urls={world.audioUrls} muted={muted} />
      </Suspense>
    </Canvas>
  )
}
