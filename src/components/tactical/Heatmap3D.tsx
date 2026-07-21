import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import { useTranslation } from 'react-i18next'
import type { Heatmap3DState } from '../../engine/orderbook/heatmap3d'

interface Props {
  heatmap3D: Heatmap3DState
}

function VolumeCloud({ heatmap3D }: { heatmap3D: Heatmap3DState }) {
  const groupRef = useRef<THREE.Group>(null)

  const meshes = useMemo(() => {
    return heatmap3D.points.map((point, i) => ({
      key: `${point.side}-${point.price}-${point.y}-${i}`,
      position: [point.x, point.z * 0.5, point.y] as [number, number, number],
      color: point.side === 'BID' ? '#22c55e' : '#ef4444',
      scale: 0.02 + Math.min(point.z, 1.5) * 0.03,
    }))
  }, [heatmap3D.points])

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.rotation.y += 0.002
    }
  })

  return (
    <group ref={groupRef}>
      {meshes.map((m) => (
        <mesh key={m.key} position={m.position} scale={m.scale}>
          <sphereGeometry args={[1, 6, 6]} />
          <meshStandardMaterial color={m.color} transparent opacity={0.85} />
        </mesh>
      ))}
    </group>
  )
}

const Heatmap3D = ({ heatmap3D }: Props) => {
  const { t } = useTranslation()

  if (heatmap3D.points.length < 10) {
    return (
      <div className="rounded-lg bg-hull-light/20 p-6 text-center">
        <span className="text-xs text-holo/50">{t('heatmap_3d_accumulating')}</span>
      </div>
    )
  }

  return (
    <div
      className="relative overflow-hidden rounded-lg bg-hull-light/20"
      style={{ height: 300 }}
    >
      <Canvas>
        <PerspectiveCamera makeDefault position={[2.2, 1.8, 2.2]} />
        <OrbitControls
          enableDamping
          dampingFactor={0.05}
          minDistance={1}
          maxDistance={6}
        />
        <ambientLight intensity={0.55} />
        <pointLight position={[8, 8, 8]} intensity={1} />
        <gridHelper args={[4, 20, 0x64c8ff, 0x2a3f5f]} />
        <axesHelper args={[1.5]} />
        <VolumeCloud heatmap3D={heatmap3D} />
      </Canvas>

      <div className="absolute bottom-2 left-2 space-y-1 rounded bg-hull/80 px-2 py-1 text-[10px]">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-matrix" />
          <span className="text-holo/80">BID</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-alert" />
          <span className="text-holo/80">ASK</span>
        </div>
        <div className="mt-1 text-holo/50">{t('heatmap_3d_axis')}</div>
      </div>
    </div>
  )
}

export default Heatmap3D
