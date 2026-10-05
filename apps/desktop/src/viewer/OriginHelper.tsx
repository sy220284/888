/**
 * Adapted from neilsonnn/image-blaster (MIT).
 * Upstream snapshot: 4acb43ba126a12358f71838d1b1a05e856b10eaf
 * See THIRD_PARTY_NOTICES.md.
 */
interface Props {
  visible?: boolean
}

export function OriginHelper({ visible = false }: Props) {
  if (!visible) return null

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[10, 10]} />
        <meshBasicMaterial color={0x00ff88} wireframe />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.5, 16, 12]} />
        <meshBasicMaterial color={0xff4400} wireframe />
      </mesh>
    </group>
  )
}
