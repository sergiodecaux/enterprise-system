import { Layers } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface Props {
  currentDepth: number
  onDepthChange: (depth: number) => void
}

const DEPTH_OPTIONS = [10, 20, 50]

const DepthSettings = ({ currentDepth, onDepthChange }: Props) => {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-2" title={t('depth_setting')}>
      <Layers className="w-4 h-4 text-holo/50" />
      <div className="flex gap-1">
        {DEPTH_OPTIONS.map((depth) => (
          <button
            key={depth}
            type="button"
            onClick={() => onDepthChange(depth)}
            className={`px-2 py-1 text-xs font-mono rounded transition-all ${
              currentDepth === depth
                ? 'bg-matrix/20 text-matrix border border-matrix/50 font-bold'
                : 'bg-hull-light/50 text-holo/60 hover:bg-hull-light border border-transparent'
            }`}
          >
            {depth}
          </button>
        ))}
      </div>
    </div>
  )
}

export default DepthSettings
