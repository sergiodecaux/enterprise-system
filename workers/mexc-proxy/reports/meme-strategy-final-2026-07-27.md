# MEME Strategy Final — Order-Flow MM Join (v24)

**Source lab:** `meme-causality-2026-07-26T20-10-12` (~60 min, 33–34 batches, ~107 impulses: ~50–53 PUMP / ~57 DUMP)  
**Engine:** `meme-order-flow-v24` · cron role `predator` `*/2`  
**Module:** `workers/mexc-proxy/src/memeOrderFlow.ts`

---

## Verdict

Liquidation Echo почти не срабатывает на мемах → стратегия заменена на **join MM order-flow** по горячему дневному списку (тонкий стакан = вселенная, не сигнал).

## Lab findings → rules

| Finding | Rule in bot |
|--------|-------------|
| THIN_BOOK на каждом импульсе | Universe filter via hot watchlist + thin-vol prefer ($200k–$5M) |
| WIDE_SPREAD ухудшает вход | Skip if spread >55 bps; >40 bps needs conf≥90 |
| PUMP + sell-tape без absorption = unload | No chase LONG without ABSORPTION / SPOOF / wall-release |
| DUMP + buy-tape = cover в падение | Trade WITH day bias only (no reverse LONG on dump day) |
| Edge: ABSORPTION / SPOOF_SWEEP / wall-remove + day bias | Only these kinds (conf≥84), max 1 alert / tick |
| Liq cascade ≈ useless | Not waited; cascade fade optional but not primary |

## Execution

- **Entry:** limit-chase (maker) at wall / absorption price  
- **SL ~0.8% · TP ~2% · TP1 ~1.5%**  
- **Align:** WITH day bias (PUMP→LONG, DUMP→SHORT)  
- **Skip:** WASH, trap (non-spoof), against-day, unload chase  

## What changed from Predator Liq-Echo

1. Cron `runPredator` → `runMemeOrderFlowScan`  
2. Hotlist → sticky `hot_meme_watchlist_v1` (not powder-keg)  
3. `/status` / health / welcome text → Order-Flow MM Join  
4. Engine id → `meme-order-flow-v24`

## Expected ops

- Quiet ticks: `no_ready` / reject reasons in logs (`conf`, `wide_spread`, `against_*`)  
- Alerts rare by design (MAX_ALERTS=1, high gate)  
- Paper companion still wraps MEME plans; delivery path unchanged  
