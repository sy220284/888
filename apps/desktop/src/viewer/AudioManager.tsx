/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoader, useThree } from '@react-three/fiber'
import * as THREE from 'three'

const BASE_VOLUME = 0.6

function useAudioReady() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const unlock = () => {
      const context = THREE.AudioContext.getContext()
      if (context.state === 'suspended') context.resume().catch(() => {})
      setReady(true)
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    window.addEventListener('touchstart', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      window.removeEventListener('touchstart', unlock)
    }
  }, [])

  return ready
}

function Player({ urls, muted }: { urls: string[]; muted: boolean }) {
  const camera = useThree((state) => state.camera)
  const buffers = useLoader(THREE.AudioLoader, urls) as AudioBuffer[]
  const soundsRef = useRef<THREE.Audio[]>([])
  const listener = useMemo(() => new THREE.AudioListener(), [])

  const start = useCallback(() => {
    if (listener.context.state === 'suspended') listener.context.resume().catch(() => {})
    for (const sound of soundsRef.current) if (!sound.isPlaying) sound.play()
  }, [listener])

  useEffect(() => {
    camera.add(listener)
    return () => {
      listener.removeFromParent()
    }
  }, [camera, listener])

  useEffect(() => {
    const sounds = buffers.map((buffer) => {
      const sound = new THREE.Audio(listener)
      sound.setBuffer(buffer)
      sound.setLoop(true)
      sound.setVolume(muted ? 0 : BASE_VOLUME)
      return sound
    })
    soundsRef.current = sounds
    if (!muted) start()
    return () => {
      for (const sound of sounds) {
        if (sound.isPlaying) sound.stop()
        sound.disconnect()
      }
      soundsRef.current = []
    }
  }, [buffers, listener, muted, start])

  useEffect(() => {
    for (const sound of soundsRef.current) sound.setVolume(muted ? 0 : BASE_VOLUME)
    if (muted) {
      for (const sound of soundsRef.current) if (sound.isPlaying) sound.stop()
    } else {
      start()
    }
  }, [muted, start])

  return null
}

export function AudioManager({ urls, muted = false }: { urls: string[]; muted?: boolean }) {
  const ready = useAudioReady()
  if (!ready || urls.length === 0) return null
  return <Player key={urls.join('|')} urls={urls} muted={muted} />
}
