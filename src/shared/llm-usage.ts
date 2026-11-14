/** Usage reported by providers; unknown calls must never be represented as zero usage. */
export interface LLMUsagePeriod {
  totalCalls: number
  knownUsageCalls: number
  totalTokens: number | null
}

export interface LLMUsagePeriods {
  today: LLMUsagePeriod
  week: LLMUsagePeriod
}
