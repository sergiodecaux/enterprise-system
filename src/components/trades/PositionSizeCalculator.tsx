import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, ShieldAlert } from 'lucide-react'
import Button from '../ui/Button'
import Badge from '../ui/Badge'
import Modal from '../ui/Modal'
import Sheet from '../ui/Sheet'
import { useDesktopLayout } from '../../hooks/useDesktopLayout'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'

export interface PositionSizeCalculatorProps {
  isOpen: boolean
  onClose: () => void
  symbol: string
  displayName: string
  direction: 'LONG' | 'SHORT'
  entry: number
  sl: number
  tp1?: number | null
  tp2?: number | null
  /** Returns the notional position size in USDT. */
  onConfirm?: (positionSizeUsd: number) => void
}

const DEPOSIT_KEY = 'enterprise.risk.deposit'
const RISK_PRESETS = [0.5, 1, 2] as const
const LEVERAGE_PRESETS = [1, 3, 5, 10, 20, 50] as const
const MAINTENANCE_MARGIN_RATE = 0.005

const loadDeposit = (): string => {
  if (typeof window === 'undefined') return '1000'
  try {
    const raw = window.localStorage.getItem(DEPOSIT_KEY)
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) return String(value)
  } catch {
    /* localStorage can be blocked */
  }
  return '1000'
}

const parseDecimal = (value: string): number => {
  const normalized = value.replace(',', '.').trim()
  if (!normalized) return 0
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

const fmtUsd = (value: number): string =>
  value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const fmtQty = (value: number): string =>
  value.toLocaleString('ru-RU', { maximumFractionDigits: 6 })

const fmtPrice = (value: number): string => {
  if (!(value > 0)) return '—'
  if (value >= 1000)
    return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  if (value >= 1) return value.toFixed(4)
  return value.toFixed(6)
}

const Field = ({
  label,
  hint,
  value,
  onChange,
  suffix,
  inputMode = 'decimal',
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  suffix?: string
  inputMode?: 'decimal' | 'numeric'
}) => (
  <label className="block">
    <span className="mb-1.5 flex items-center justify-between gap-2 font-sans text-[11px] font-medium text-text-secondary">
      {label}
      {hint && <span className="font-normal text-text-muted">{hint}</span>}
    </span>
    <span className="flex h-10 items-center rounded-md border border-border bg-bg-base px-2.5 focus-within:border-brand/50">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        autoComplete="off"
        className="tnum min-w-0 flex-1 bg-transparent font-mono text-[13px] text-text-primary outline-none placeholder:text-text-muted"
      />
      {suffix && (
        <span className="ml-2 shrink-0 font-mono text-[11px] text-text-muted">
          {suffix}
        </span>
      )}
    </span>
  </label>
)

const Metric = ({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'long' | 'short' | 'warning'
}) => {
  const toneClass =
    tone === 'long'
      ? 'text-market-long'
      : tone === 'short'
        ? 'text-market-short'
        : tone === 'warning'
          ? 'text-market-warning'
          : 'text-text-primary'
  return (
    <div>
      <div className="font-sans text-[11px] text-text-muted">{label}</div>
      <div className={`tnum mt-0.5 font-mono text-[13px] font-medium ${toneClass}`}>
        {value}
      </div>
    </div>
  )
}

/**
 * Replaces the old `window.prompt` position sizing. The account size and
 * risk are remembered locally; entry/SL come from the selected setup.
 */
const PositionSizeCalculator = ({
  isOpen,
  onClose,
  symbol,
  displayName,
  direction,
  entry,
  sl,
  tp1 = null,
  tp2 = null,
  onConfirm,
}: PositionSizeCalculatorProps) => {
  const isDesktop = useDesktopLayout()
  const { haptic } = useTelegramWebApp()
  const [depositInput, setDepositInput] = useState(loadDeposit)
  const [riskInput, setRiskInput] = useState('1')
  const [entryInput, setEntryInput] = useState(() => String(entry))
  const [slInput, setSlInput] = useState(() => String(sl))
  const [leverage, setLeverage] = useState(10)
  const [copied, setCopied] = useState(false)
  const wasOpen = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setEntryInput(String(entry))
      setSlInput(String(sl))
      setCopied(false)
    }
    wasOpen.current = isOpen
  }, [isOpen, entry, sl])

  useEffect(() => {
    try {
      window.localStorage.setItem(DEPOSIT_KEY, depositInput)
    } catch {
      /* ignore */
    }
  }, [depositInput])

  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(id)
  }, [copied])

  const calc = useMemo(() => {
    const deposit = parseDecimal(depositInput)
    const riskPct = parseDecimal(riskInput)
    const entryPrice = parseDecimal(entryInput)
    const stopPrice = parseDecimal(slInput)
    const stopDistance = Math.abs(entryPrice - stopPrice)
    const stopPct = entryPrice > 0 ? stopDistance / entryPrice : 0
    const riskUsd = (deposit * riskPct) / 100
    const notional = stopPct > 0 ? riskUsd / stopPct : 0
    const qty = entryPrice > 0 ? notional / entryPrice : 0
    const margin = leverage > 0 ? notional / leverage : 0
    const liqPrice =
      entryPrice > 0 && leverage > 0
        ? direction === 'LONG'
          ? entryPrice * (1 - 1 / leverage + MAINTENANCE_MARGIN_RATE)
          : entryPrice * (1 + 1 / leverage - MAINTENANCE_MARGIN_RATE)
        : 0
    const tp1Profit =
      tp1 != null && entryPrice > 0
        ? notional * (Math.abs(tp1 - entryPrice) / entryPrice)
        : 0
    const tp2Profit =
      tp2 != null && entryPrice > 0
        ? notional * (Math.abs(tp2 - entryPrice) / entryPrice)
        : 0
    const rr = tp1 != null && stopDistance > 0
      ? Math.abs(tp1 - entryPrice) / stopDistance
      : 0

    const wrongSide =
      entryPrice > 0 &&
      stopPrice > 0 &&
      (direction === 'LONG' ? stopPrice >= entryPrice : stopPrice <= entryPrice)
    const liqBeforeSl =
      entryPrice > 0 &&
      stopPrice > 0 &&
      leverage > 0 &&
      !wrongSide &&
      (direction === 'LONG' ? liqPrice >= stopPrice : liqPrice <= stopPrice)
    const marginTooHigh = deposit > 0 && margin > deposit
    const invalid =
      deposit <= 0 ||
      riskPct <= 0 ||
      entryPrice <= 0 ||
      stopPrice <= 0 ||
      stopDistance <= 0

    const warnings: string[] = []
    if (wrongSide) {
      warnings.push(
        direction === 'LONG'
          ? 'Для LONG стоп должен быть ниже цены входа.'
          : 'Для SHORT стоп должен быть выше цены входа.'
      )
    }
    if (liqBeforeSl) {
      warnings.push(
        'Плечо слишком высокое: цена ликвидации ближе стоп-лосса. Сделка не переживёт нормальный шум.'
      )
    }
    if (marginTooHigh) {
      warnings.push('Маржа больше депозита. Уменьшите плечо или размер позиции.')
    }
    if (riskPct > 5) {
      warnings.push('Риск выше 5% на сделку — это агрессивно даже для скальпа.')
    }

    return {
      deposit,
      riskPct,
      entryPrice,
      stopPrice,
      stopDistance,
      stopPct,
      riskUsd,
      notional,
      qty,
      margin,
      liqPrice,
      tp1Profit,
      tp2Profit,
      rr,
      wrongSide,
      liqBeforeSl,
      marginTooHigh,
      invalid,
      warnings,
      canConfirm:
        !invalid && !wrongSide && !liqBeforeSl && !marginTooHigh,
    }
  }, [
    depositInput,
    riskInput,
    entryInput,
    slInput,
    leverage,
    direction,
    tp1,
    tp2,
  ])

  const base = symbol.replace(/USDT$/i, '').replace(/_USDT$/i, '')

  const copyParams = () => {
    const lines = [
      `${displayName} · ${direction}`,
      `Entry: ${fmtPrice(calc.entryPrice)}`,
      `SL: ${fmtPrice(calc.stopPrice)}`,
      tp1 != null ? `TP1: ${fmtPrice(tp1)}` : null,
      tp2 != null ? `TP2: ${fmtPrice(tp2)}` : null,
      `Position: ${fmtUsd(calc.notional)} USDT`,
      `Qty: ${fmtQty(calc.qty)} ${base}`,
      `Margin: ${fmtUsd(calc.margin)} USDT`,
      `Leverage: ${leverage}x`,
      `Risk: ${fmtUsd(calc.riskUsd)} USDT (${calc.riskPct}%)`,
      `Liq (est.): ${fmtPrice(calc.liqPrice)}`,
    ].filter(Boolean)
    void navigator.clipboard
      ?.writeText(lines.join('\n'))
      .then(() => {
        setCopied(true)
        haptic.impact()
      })
      .catch(() => setCopied(false))
  }

  const handleConfirm = () => {
    if (!calc.canConfirm) return
    if (!onConfirm) {
      copyParams()
      return
    }
    haptic.success()
    onConfirm(Number(calc.notional.toFixed(2)))
    onCloseRef.current()
  }

  const content = (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Депозит"
          hint="USDT"
          value={depositInput}
          onChange={setDepositInput}
          suffix="USDT"
        />
        <div>
          <Field
            label="Риск на сделку"
            hint="% от депозита"
            value={riskInput}
            onChange={setRiskInput}
            suffix="%"
          />
          <div className="mt-1.5 flex gap-1">
            {RISK_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setRiskInput(String(preset))}
                className={`h-7 flex-1 rounded-sm border font-mono text-[11px] transition-colors ${
                  parseDecimal(riskInput) === preset
                    ? 'border-brand/30 bg-brand/10 text-brand'
                    : 'border-border text-text-secondary hover:border-border-active hover:text-text-primary'
                }`}
              >
                {preset}%
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Цена входа"
          value={entryInput}
          onChange={setEntryInput}
          suffix="USDT"
        />
        <Field
          label="Стоп-лосс"
          value={slInput}
          onChange={setSlInput}
          suffix="USDT"
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="font-sans text-[11px] font-medium text-text-secondary">
            Кредитное плечо
          </span>
          <span className="font-mono text-[13px] font-medium text-text-primary">
            {leverage}x
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={50}
          step={1}
          value={leverage}
          onChange={(event) => setLeverage(Number(event.target.value))}
          className="h-1 w-full accent-brand"
        />
        <div className="mt-1.5 flex gap-1">
          {LEVERAGE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setLeverage(preset)}
              className={`h-7 flex-1 rounded-sm border font-mono text-[11px] transition-colors ${
                leverage === preset
                  ? 'border-brand/30 bg-brand/10 text-brand'
                  : 'border-border text-text-secondary hover:border-border-active hover:text-text-primary'
              }`}
            >
              {preset}x
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-bg-base/60 p-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <Metric label="Позиция" value={`$${fmtUsd(calc.notional)}`} />
          <Metric label={`Объём, ${base}`} value={fmtQty(calc.qty)} />
          <Metric label="Маржа" value={`$${fmtUsd(calc.margin)}`} />
          <Metric
            label="Риск при SL"
            value={`$${fmtUsd(calc.riskUsd)} · ${calc.riskPct}%`}
            tone="warning"
          />
          <Metric
            label="Прибыль TP1"
            value={tp1 != null ? `+$${fmtUsd(calc.tp1Profit)}` : '—'}
            tone="long"
          />
          <Metric
            label="Прибыль TP2"
            value={tp2 != null ? `+$${fmtUsd(calc.tp2Profit)}` : '—'}
            tone="long"
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-2.5">
          <span className="font-sans text-[11px] text-text-muted">
            R:R до TP1
          </span>
          <span className="font-mono text-[13px] font-medium text-text-primary">
            {calc.rr > 0 ? `1 : ${calc.rr.toFixed(2)}` : '—'}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <span className="font-sans text-[11px] text-text-muted">
            Ликвидация (оценка)
          </span>
          <span
            className={`font-mono text-[13px] font-medium ${
              calc.liqBeforeSl ? 'text-market-short' : 'text-text-secondary'
            }`}
          >
            ${fmtPrice(calc.liqPrice)}
          </span>
        </div>
      </div>

      {calc.warnings.length > 0 && (
        <div className="space-y-1.5">
          {calc.warnings.map((warning) => (
            <div
              key={warning}
              className="flex items-start gap-2 rounded-md border border-market-warning/20 bg-market-warning/[0.06] px-2.5 py-2"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-market-warning" />
              <span className="font-sans text-[11px] leading-4 text-market-warning">
                {warning}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="font-sans text-[11px] leading-4 text-text-muted">
        Расчёт для USDT-M perpetual. Ликвидация — оценка без учёта
        поддерживающей маржи биржи; всегда проверяйте параметры в MEXC.
      </p>
    </div>
  )

  const footer = (
    <div className="flex w-full items-center gap-2">
      <Button variant="ghost" size="md" onClick={() => onCloseRef.current()}>
        Отмена
      </Button>
      <Button
        variant="secondary"
        size="md"
        onClick={copyParams}
        className="ml-auto"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-market-long" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        <span className="hidden min-[380px]:inline">
          {copied ? 'Скопировано' : 'Копировать'}
        </span>
      </Button>
      <Button
        variant={direction === 'LONG' ? 'long' : 'short'}
        size="md"
        onClick={handleConfirm}
        disabled={!calc.canConfirm}
      >
        <ShieldAlert className="h-3.5 w-3.5" />
        {onConfirm ? 'Открыть сделку' : 'Готово'}
      </Button>
    </div>
  )

  const description = (
    <span className="flex items-center gap-2">
      {displayName}
      <Badge tone={direction === 'LONG' ? 'long' : 'short'} uppercase>
        {direction}
      </Badge>
    </span>
  )

  if (isDesktop) {
    return (
      <Modal
        open={isOpen}
        onClose={onClose}
        title="Калькулятор позиции"
        description={description}
        footer={footer}
        size="md"
      >
        {content}
      </Modal>
    )
  }

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      title="Калькулятор позиции"
      description={description}
      footer={footer}
    >
      {content}
    </Sheet>
  )
}

export default PositionSizeCalculator
