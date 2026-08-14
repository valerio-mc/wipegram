export type DiagnosticLevel = "info" | "warn" | "error"

export interface DiagnosticEntry {
  readonly at: Date
  readonly level: DiagnosticLevel
  readonly operation: string
  readonly outcome: string
  readonly durationMs?: number
  readonly count?: number
  readonly code?: string
}

export class Diagnostics {
  readonly #entries: DiagnosticEntry[] = []

  constructor(private readonly capacity = 80) {}

  record(entry: Omit<DiagnosticEntry, "at">): void {
    this.#entries.push({ at: new Date(), ...entry })
    if (this.#entries.length > this.capacity) this.#entries.shift()
  }

  snapshot(): readonly DiagnosticEntry[] {
    return this.#entries.slice()
  }
}
