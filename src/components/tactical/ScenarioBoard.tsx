import type {
  StoryLegendItem,
  StoryScenario,
  StoryScenarioId,
} from '../../engine/smc/chartStory'
import { fmtStoryTargetPx, storyPathColor } from '../../engine/smc/chartStory'

interface BoardProps {
  scenarios: StoryScenario[]
  activeId: StoryScenarioId
  onSelect: (id: StoryScenarioId) => void
  dense?: boolean
}

interface LegendProps {
  items: StoryLegendItem[]
  /** «только сильная» still lists what the filled band means */
  onlyStrong?: boolean
}

function pctTone(n: number): string {
  if (n >= 40) return 'text-emerald-200'
  if (n >= 22) return 'text-amber-200'
  return 'text-white/70'
}

function dirTone(side: StoryScenario['side']): string {
  if (side === 'LONG') return 'text-teal-200'
  if (side === 'SHORT') return 'text-rose-200'
  return 'text-amber-200'
}

const FALLBACK_ROWS: StoryScenario[] = [
  {
    id: 'hold',
    pct: 40,
    side: 'LONG',
    dirLabel: 'лонг',
    condition: 'если закрепятся над зоной',
    title: 'лонг → ликвидность сверху',
    path: [],
    toPrice: null,
    toLabel: '',
    tipLabel: '',
  },
  {
    id: 'sweep',
    pct: 22,
    side: 'LONG',
    dirLabel: 'лонг',
    condition: 'если снимут лои и закроются обратно',
    title: 'свип → разворот',
    path: [],
    toPrice: null,
    toLabel: '',
    tipLabel: '',
  },
  {
    id: 'break',
    pct: 22,
    side: 'SHORT',
    dirLabel: 'шорт',
    condition: 'если закроют ниже зоны',
    title: 'слом',
    path: [],
    toPrice: null,
    toLabel: '',
    tipLabel: '',
  },
  {
    id: 'chop',
    pct: 16,
    side: 'RANGE',
    dirLabel: 'пила',
    condition: 'если останемся внутри',
    title: 'пила → край диапазона',
    path: [],
    toPrice: null,
    toLabel: '',
    tipLabel: '',
  },
]

/** Compact 4-row SMC board under candles — never an overlay on price. */
export const ScenarioBoard = ({
  scenarios,
  activeId,
  onSelect,
  dense = false,
}: BoardProps) => {
  const rows =
    scenarios.length >= 4
      ? scenarios.slice(0, 4)
      : FALLBACK_ROWS.map((stub) => scenarios.find((s) => s.id === stub.id) ?? stub)
  return (
    <div
      className={`shrink-0 border-t border-white/[0.08] bg-[#0a0c10] ${
        dense ? 'px-1.5 py-1' : 'px-2 py-1.5'
      }`}
    >
      <ul className="flex flex-col gap-0.5">
        {rows.map((sc) => {
          const on = sc.id === activeId
          return (
            <li key={sc.id}>
              <button
                type="button"
                onClick={() => onSelect(sc.id)}
                className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left font-mono leading-tight ${
                  on
                    ? 'bg-white/[0.08] ring-1 ring-white/20'
                    : 'hover:bg-white/[0.04]'
                }`}
                title={`${sc.title}. ${sc.condition}`}
              >
                <span
                  className="h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{
                    background: storyPathColor(sc.id, sc.side),
                    opacity: on ? 1 : 0.45,
                    boxShadow: on
                      ? `0 0 6px ${storyPathColor(sc.id, sc.side)}`
                      : 'none',
                  }}
                />
                <span
                  className={`w-8 shrink-0 text-right font-bold tabular-nums ${
                    dense ? 'text-[11px]' : 'text-[10px]'
                  } ${pctTone(sc.pct)}`}
                >
                  {Math.round(sc.pct)}%
                </span>
                <span
                  className={`w-[2.6rem] shrink-0 font-bold uppercase ${
                    dense ? 'text-[10px]' : 'text-[9px]'
                  } ${dirTone(sc.side)}`}
                >
                  {sc.dirLabel}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate ${
                    dense ? 'text-[11px]' : 'text-[10px]'
                  } ${on ? 'text-white/90' : 'text-white/65'}`}
                >
                  {sc.condition}
                </span>
                {sc.toPrice != null && sc.toPrice > 0 && (
                  <span
                    className={`shrink-0 tabular-nums ${
                      dense ? 'text-[10px]' : 'text-[9px]'
                    } ${on ? 'text-white/70' : 'text-white/40'}`}
                  >
                    {fmtStoryTargetPx(sc.toPrice)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Always-visible: 1 сильная + слабые listed, even if only the strong band is drawn. */
export const ZoneLegend = ({ items, onlyStrong = false }: LegendProps) => {
  const strong =
    items.find((i) => i.role === 'STRONG') ??
    ({
      role: 'STRONG' as const,
      text: 'сильная · зона на графике',
      range: '',
      take: null,
    } satisfies StoryLegendItem)
  const weaks = items.filter((i) => i.role === 'WEAK')
  return (
    <div className="shrink-0 border-t border-white/[0.06] bg-[#080a0e] px-2 py-1.5 font-mono leading-snug text-[11px] text-white/80">
      {strong && (
        <p className="text-teal-100">
          <span className="font-bold uppercase tracking-wide text-teal-200">
            сильная
          </span>
          {' · '}
          {strong.text}
          <span className="text-white/50"> {strong.range}</span>
        </p>
      )}
      {weaks.length > 0 && (
        <p className="text-white/55">
          <span className="font-bold uppercase tracking-wide text-white/40">
            {onlyStrong ? 'слабые (контекст)' : 'слабые'}
          </span>
          {' · '}
          {weaks.map((w) => w.text.replace(/^слабая ·\s*/, '')).join(' · ')}
        </p>
      )}
    </div>
  )
}

export default ScenarioBoard
