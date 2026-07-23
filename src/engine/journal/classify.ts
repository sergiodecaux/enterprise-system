import type { CoinSignal, MemeSignal } from '../types'
import type { JournalSetupType, JournalSource } from './types'

export function classifyMemeSetup(meme: MemeSignal): {
  setupType: JournalSetupType
  setupTag: string
} {
  if (meme.setupTag) {
    const tag = meme.setupTag.toUpperCase()
    if (tag.includes('SQUEEZE') || meme.squeeze?.detected)
      return { setupType: 'SQUEEZE', setupTag: meme.setupTag }
    if (tag.includes('FLAT') || meme.flatline?.detected)
      return { setupType: 'FLATLINE', setupTag: meme.setupTag }
    if (tag.includes('BACK') || meme.backside?.detected)
      return { setupType: 'BACKSIDE', setupTag: meme.setupTag }
    if (tag.includes('CVD') || meme.cvdTrap?.detected)
      return { setupType: 'CVD_TRAP', setupTag: meme.setupTag }
    if (tag.includes('ABSORB') || meme.absorptionAlert?.detected)
      return { setupType: 'ABSORPTION', setupTag: meme.setupTag }
  }

  if (meme.squeeze?.setup || meme.squeeze?.inProgress || meme.squeeze?.detected)
    return { setupType: 'SQUEEZE', setupTag: meme.squeeze.label || 'SQUEEZE' }
  if (meme.flatline?.detected)
    return { setupType: 'FLATLINE', setupTag: meme.flatline.label || 'FLATLINE' }
  if (meme.backside?.detected)
    return { setupType: 'BACKSIDE', setupTag: meme.backside.label || 'BACKSIDE' }
  if (meme.cvdTrap?.detected)
    return { setupType: 'CVD_TRAP', setupTag: meme.cvdTrap.label || 'CVD_TRAP' }
  if (meme.absorptionAlert?.detected)
    return {
      setupType: 'ABSORPTION',
      setupTag: meme.absorptionAlert.label || 'ABSORPTION',
    }
  if (meme.meanReversion?.detected)
    return {
      setupType: 'MEAN_REVERSION',
      setupTag: meme.meanReversion.label || 'MEAN_REVERSION',
    }
  if (meme.volumeSpike?.detected)
    return {
      setupType: 'VOLUME_SPIKE',
      setupTag: meme.volumeSpike.label || 'VOLUME_SPIKE',
    }
  if (meme.spreadPressure?.pressure !== 'NEUTRAL')
    return {
      setupType: 'SPREAD_PRESSURE',
      setupTag: meme.spreadPressure.label || 'SPREAD',
    }

  return { setupType: 'UNKNOWN', setupTag: meme.setupTag || 'MEME' }
}

export function classifySmcSetup(signal: CoinSignal): {
  setupType: JournalSetupType
  setupTag: string
  source: JournalSource
} {
  if (signal.memePulse) {
    const m = classifyMemeSetup(signal.memePulse)
    return { ...m, source: 'MEME' }
  }

  if (signal.raid?.isFresh && signal.raid.type !== 'NONE') {
    return {
      setupType: 'LIQUIDITY_RAID',
      setupTag: signal.raid.label || 'RAID',
      source: 'SNIPER',
    }
  }
  if (signal.absorption?.detected) {
    return {
      setupType: 'ABSORPTION',
      setupTag: signal.absorption.label || 'ABSORPTION',
      source: 'SNIPER',
    }
  }

  const style = signal.tradeStyle ?? 'INTRADAY'
  if (style === 'SCALP')
    return {
      setupType: 'SCALP_SMC',
      setupTag: signal.zones[0] || 'SCALP',
      source: 'SNIPER',
    }
  if (style === 'SWING')
    return {
      setupType: 'SWING_SMC',
      setupTag: signal.zones[0] || 'SWING',
      source: 'SNIPER',
    }
  return {
    setupType: 'INTRADAY_SMC',
    setupTag: signal.zones[0] || 'INTRADAY',
    source: 'SNIPER',
  }
}

export const SETUP_LABELS: Record<JournalSetupType, string> = {
  SQUEEZE: 'Squeeze',
  FLATLINE: 'Flatline',
  BACKSIDE: 'Backside Short',
  CVD_TRAP: 'CVD Trap',
  ABSORPTION: 'Absorption',
  LIQUIDITY_RAID: 'Liquidity Raid',
  MEAN_REVERSION: 'Mean Reversion',
  VOLUME_SPIKE: 'Volume Spike',
  SPREAD_PRESSURE: 'Spread Pressure',
  SCALP_SMC: 'Scalp SMC',
  INTRADAY_SMC: 'Intraday SMC',
  SWING_SMC: 'Swing SMC',
  UNKNOWN: 'Other',
}
