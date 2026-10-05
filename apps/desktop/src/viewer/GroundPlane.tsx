/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
import { CuboidCollider, RigidBody } from '@react-three/rapier'

const SIZE = 200
const THICKNESS = 0.05

interface Props {
  enabled?: boolean
  visible?: boolean
}

export function GroundPlane({ enabled = true, visible = false }: Props) {
  return (
    <>
      {enabled && visible && <gridHelper args={[SIZE, 100]} position={[0, 0.001, 0]} />}
      {enabled && (
        <RigidBody type="fixed">
          <CuboidCollider
            args={[SIZE / 2, THICKNESS, SIZE / 2]}
            position={[0, -THICKNESS, 0]}
          />
        </RigidBody>
      )}
      <RigidBody type="fixed" position={[0, -10, 0]}>
        <CuboidCollider args={[SIZE / 2, 1, SIZE / 2]} />
      </RigidBody>
    </>
  )
}
