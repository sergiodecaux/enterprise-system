import {
  Activity,
  Radar as RadarIcon,
  Target,
  Zap,
  type LucideIcon,
} from 'lucide-react'

export type WorkspaceId = 'sniper' | 'trades' | 'radar' | 'signals'

export interface WorkspaceMeta {
  id: WorkspaceId
  label: string
  /** Короткое пояснение для боковой панели и подсказок. */
  hint: string
  icon: LucideIcon
  shortcut: string
}

/** Порядок и подписи разделов ПК-терминала. */
export const WORKSPACES: WorkspaceMeta[] = [
  {
    id: 'sniper',
    label: 'Снайпер',
    hint: 'живые лимитки и готовые входы',
    icon: Target,
    shortcut: 'Alt+1',
  },
  {
    id: 'trades',
    label: 'Сделки',
    hint: 'журнал, бот и статистика',
    icon: Activity,
    shortcut: 'Alt+2',
  },
  {
    id: 'radar',
    label: 'Радар',
    hint: 'охота, 141 и сильные монеты',
    icon: RadarIcon,
    shortcut: 'Alt+3',
  },
  {
    id: 'signals',
    label: 'Сигналы',
    hint: 'быстрый разбор инструмента',
    icon: Zap,
    shortcut: 'Alt+4',
  },
]

export function workspaceById(id: WorkspaceId): WorkspaceMeta {
  return WORKSPACES.find((w) => w.id === id) ?? WORKSPACES[0]
}
