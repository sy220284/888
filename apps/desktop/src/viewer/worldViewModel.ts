/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
export type ViewerQuality = 'low' | 'high'

export interface WorldViewModel {
  splatUrl?: string
  colliderUrl?: string
  panoUrl?: string
  audioUrls?: string[]
  metricScaleFactor?: number
  groundPlaneOffset?: number
  flipY?: boolean
}

export interface NormalizedWorldViewModel {
  splatUrl?: string
  colliderUrl?: string
  panoUrl?: string
  audioUrls: string[]
  metricScaleFactor: number
  groundPlaneOffset: number
  flipY: boolean
}

export function normalizeWorldViewModel(world: WorldViewModel): NormalizedWorldViewModel {
  const requestedScale = world.metricScaleFactor ?? 1
  return {
    splatUrl: world.splatUrl,
    colliderUrl: world.colliderUrl,
    panoUrl: world.panoUrl,
    audioUrls: world.audioUrls ?? [],
    metricScaleFactor: Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1,
    groundPlaneOffset: Number.isFinite(world.groundPlaneOffset) ? world.groundPlaneOffset! : 0,
    flipY: world.flipY ?? false,
  }
}
