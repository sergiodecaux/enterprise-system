/**
 * RSICalculator - Client-side RSI calculation using Wilder's Smoothing Method
 * 
 * Calculates Relative Strength Index (RSI) from streaming price data.
 * Uses Wilder's exponential smoothing for accurate RSI calculation.
 */
export class RSICalculator {
  private period: number
  private prices: number[] = []
  private readonly MAX_BUFFER_SIZE = 200

  constructor(period: number = 14) {
    if (period < 1) {
      throw new Error('RSI period must be at least 1')
    }
    this.period = period
  }

  /**
   * Add a new closing price to the buffer
   * Maintains max buffer size by removing oldest prices
   */
  addPrice(price: number): void {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('Price must be a positive finite number')
    }

    this.prices.push(price)

    // Limit buffer size
    if (this.prices.length > this.MAX_BUFFER_SIZE) {
      this.prices.shift()
    }
  }

  /**
   * Calculate current RSI value using Wilder's Smoothing Method
   * 
   * Algorithm:
   * 1. Calculate price changes (deltas)
   * 2. Separate gains and losses
   * 3. First avg gain/loss = SMA of first `period` values
   * 4. Subsequent: avgGain = (prevAvgGain * (period-1) + currentGain) / period
   * 5. RS = avgGain / avgLoss
   * 6. RSI = 100 - (100 / (1 + RS))
   * 
   * @returns RSI value (0-100) or null if insufficient data
   */
  calculate(): number | null {
    // Need at least period + 1 prices to calculate RSI
    if (this.prices.length < this.period + 1) {
      return null
    }

    // Calculate price changes (deltas)
    const deltas: number[] = []
    for (let i = 1; i < this.prices.length; i++) {
      deltas.push(this.prices[i] - this.prices[i - 1])
    }

    // Separate gains and losses
    const gains: number[] = deltas.map(delta => delta > 0 ? delta : 0)
    const losses: number[] = deltas.map(delta => delta < 0 ? Math.abs(delta) : 0)

    // Calculate initial average gain and loss (SMA of first period values)
    let avgGain = 0
    let avgLoss = 0

    for (let i = 0; i < this.period; i++) {
      avgGain += gains[i]
      avgLoss += losses[i]
    }

    avgGain = avgGain / this.period
    avgLoss = avgLoss / this.period

    // Apply Wilder's smoothing for remaining values
    for (let i = this.period; i < gains.length; i++) {
      avgGain = (avgGain * (this.period - 1) + gains[i]) / this.period
      avgLoss = (avgLoss * (this.period - 1) + losses[i]) / this.period
    }

    // Handle edge case: avgLoss = 0 (RSI = 100)
    if (avgLoss === 0) {
      return 100
    }

    // Calculate RS and RSI
    const rs = avgGain / avgLoss
    const rsi = 100 - (100 / (1 + rs))

    // Clamp RSI to valid range [0, 100]
    return Math.max(0, Math.min(100, rsi))
  }

  /**
   * Reset the calculator by clearing the price buffer
   */
  reset(): void {
    this.prices = []
  }

  /**
   * Get the current buffer size
   * @returns Number of prices currently in buffer
   */
  getBufferSize(): number {
    return this.prices.length
  }
}
