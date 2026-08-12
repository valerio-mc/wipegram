import {
  Box,
  Text,
  TextAttributes,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
  type VChild,
} from "@opentui/core"
import { Diagnostics } from "./diagnostics"
import {
  TelegramService,
  type ChatSummary,
  type DeleteProgress,
  type DeleteResult,
  type MessagePreview,
} from "./telegram"

const colors = {
  background: "#101317",
  panel: "#171c22",
  panelActive: "#1e252d",
  border: "#35404b",
  accent: "#d5f36b",
  accentDim: "#71813f",
  text: "#e7ebef",
  muted: "#77808c",
  danger: "#ff7b72",
  own: "#8bd5ca",
}

interface Field {
  label: string
  placeholder: string
  value: string
  masked: boolean
}

interface ChatRow extends ChatSummary {
  count?: number | null
  countError?: string
}

type Screen =
  | { kind: "credentials" }
  | { kind: "authenticating"; prompt?: "code" | "password"; message: string }
  | { kind: "chats" }
  | { kind: "confirm" }
  | { kind: "deleting" }
  | { kind: "result"; result: DeleteResult }
  | { kind: "diagnostics"; previous: "credentials" | "chats" }

interface PendingPrompt {
  kind: "code" | "password"
  resolve(value: string): void
}

export class WipegramApp {
  readonly #diagnostics = new Diagnostics()
  readonly #fields: Field[] = [
    { label: "API ID", placeholder: "12345678", value: "", masked: false },
    { label: "API hash", placeholder: "From my.telegram.org", value: "", masked: true },
    { label: "Phone", placeholder: "+39 333 123 4567", value: "", masked: false },
  ]
  readonly #previewCache = new Map<number, MessagePreview[]>()
  readonly #selected = new Set<number>()
  #screen: Screen = { kind: "credentials" }
  #service: TelegramService | null = null
  #activeField = 0
  #promptValue = ""
  #pendingPrompt: PendingPrompt | null = null
  #error = ""
  #status = "Credentials stay in process memory only."
  #chats: ChatRow[] = []
  #analyzed = 0
  #cursor = 0
  #search = ""
  #searching = false
  #preview: MessagePreview[] = []
  #previewLoading = false
  #previewToken = 0
  #countAbort: AbortController | null = null
  #authAbort: AbortController | null = null
  #deleteAbort: AbortController | null = null
  #deleteProgress: DeleteProgress | null = null
  #closing = false
  #refreshGeneration = 0
  readonly #signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]
  readonly #signalHandler = (): void => {
    void this.close()
  }

  constructor(private readonly renderer: CliRenderer) {}

  async start(): Promise<void> {
    this.renderer.setTerminalTitle("wipegram")
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => void this.onKey(key))
    this.renderer.keyInput.on("paste", (event: PasteEvent) => this.onPaste(event))
    this.renderer.on("resize", () => this.render())
    for (const signal of this.#signals) process.once(signal, this.#signalHandler)
    this.render()
  }

  private async onKey(key: KeyEvent): Promise<void> {
    if (key.eventType === "release") return
    if (key.ctrl && key.name === "c") {
      if (this.#screen.kind === "deleting") {
        this.#deleteAbort?.abort()
        this.#status = "Stopping after the current Telegram request..."
        this.render()
      } else {
        await this.close()
      }
      return
    }

    switch (this.#screen.kind) {
      case "credentials":
        this.handleCredentialsKey(key)
        break
      case "authenticating":
        this.handlePromptKey(key)
        break
      case "chats":
        await this.handleChatsKey(key)
        break
      case "confirm":
        await this.handleConfirmKey(key)
        break
      case "deleting":
        if (key.name === "escape") this.#deleteAbort?.abort()
        break
      case "result":
        await this.handleResultKey(key)
        break
      case "diagnostics":
        this.handleDiagnosticsKey(key)
        break
    }
  }

  private handleCredentialsKey(key: KeyEvent): void {
    if (key.name === "tab" || key.name === "down") {
      this.#activeField = (this.#activeField + 1) % this.#fields.length
    } else if (key.name === "up") {
      this.#activeField = (this.#activeField + this.#fields.length - 1) % this.#fields.length
    } else if (key.name === "backspace") {
      const field = this.#fields[this.#activeField]
      if (field) field.value = field.value.slice(0, -1)
    } else if (key.name === "return") {
      if (this.#activeField < this.#fields.length - 1) this.#activeField += 1
      else void this.authenticate()
    } else if (key.name === "?" || (key.shift && key.name === "/")) {
      this.#screen = { kind: "diagnostics", previous: "credentials" }
    } else if (isPrintable(key)) {
      this.appendInput(key.sequence)
    }
    this.render()
  }

  private handlePromptKey(key: KeyEvent): void {
    if (!this.#pendingPrompt) return
    if (key.name === "backspace") {
      this.#promptValue = this.#promptValue.slice(0, -1)
    } else if (key.name === "return" && this.#promptValue.length > 0) {
      const value = this.#promptValue
      const prompt = this.#pendingPrompt
      this.#promptValue = ""
      this.#pendingPrompt = null
      this.#screen = { kind: "authenticating", message: "Verifying with Telegram..." }
      prompt.resolve(value)
    } else if (isPrintable(key)) {
      this.#promptValue += key.sequence
    }
    this.render()
  }

  private async handleChatsKey(key: KeyEvent): Promise<void> {
    if (this.#searching) {
      if (key.name === "escape") {
        this.#searching = false
        this.#search = ""
        this.#cursor = 0
      } else if (key.name === "backspace") {
        this.#search = this.#search.slice(0, -1)
        this.#cursor = 0
      } else if (key.name === "return") {
        this.#searching = false
      } else if (isPrintable(key)) {
        this.#search += key.sequence
        this.#cursor = 0
      }
      this.render()
      void this.loadPreview()
      return
    }

    const visible = this.visibleChats()
    if (key.name === "up" || key.name === "k") {
      this.#cursor = Math.max(0, this.#cursor - 1)
      void this.loadPreview()
    } else if (key.name === "down" || key.name === "j") {
      this.#cursor = Math.min(Math.max(visible.length - 1, 0), this.#cursor + 1)
      void this.loadPreview()
    } else if (key.name === "space") {
      const chat = visible[this.#cursor]
      if (chat) {
        if (this.#selected.has(chat.id)) this.#selected.delete(chat.id)
        else this.#selected.add(chat.id)
      }
    } else if (key.name === "return") {
      await this.loadPreview(true)
    } else if (key.name === "/") {
      this.#searching = true
    } else if (key.name.toLowerCase() === "d" && this.selectedChats().length > 0) {
      this.#screen = { kind: "confirm" }
    } else if (key.name.toLowerCase() === "r") {
      await this.refresh()
    } else if (key.name === "?" || (key.shift && key.name === "/")) {
      this.#screen = { kind: "diagnostics", previous: "chats" }
    } else if (key.name.toLowerCase() === "q") {
      await this.close()
      return
    }
    this.render()
  }

  private async handleConfirmKey(key: KeyEvent): Promise<void> {
    if (key.name === "escape") this.#screen = { kind: "chats" }
    else if (key.name === "return") await this.beginDeletion()
    this.render()
  }

  private async handleResultKey(key: KeyEvent): Promise<void> {
    if (key.name === "return" || key.name === "escape") {
      this.#screen = { kind: "chats" }
      await this.refresh()
    } else if (key.name === "?" || (key.shift && key.name === "/")) {
      this.#screen = { kind: "diagnostics", previous: "chats" }
    } else if (key.name.toLowerCase() === "q") {
      await this.close()
      return
    }
    this.render()
  }

  private handleDiagnosticsKey(key: KeyEvent): void {
    if (key.name === "escape" || key.name === "?" || key.name === "return") {
      if (this.#screen.kind === "diagnostics") this.#screen = { kind: this.#screen.previous }
    }
    this.render()
  }

  private onPaste(event: PasteEvent): void {
    const value = new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, "")
    if (!value) return
    if (this.#screen.kind === "credentials") this.appendInput(value)
    else if (this.#screen.kind === "authenticating" && this.#pendingPrompt) {
      this.#promptValue += value
    } else if (this.#screen.kind === "chats" && this.#searching) {
      this.#search += value
      this.#cursor = 0
      void this.loadPreview()
    }
    this.render()
  }

  private appendInput(value: string): void {
    const field = this.#fields[this.#activeField]
    if (field) field.value += value
  }

  private async authenticate(): Promise<void> {
    const [apiIdField, apiHashField, phoneField] = this.#fields
    const apiId = Number(apiIdField?.value.trim())
    const apiHash = apiHashField?.value.trim() ?? ""
    const phone = phoneField?.value.trim() ?? ""
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash || !phone) {
      this.#error = "Enter a numeric API ID, API hash, and phone number."
      this.render()
      return
    }

    this.#error = ""
    this.#authAbort = new AbortController()
    this.#screen = { kind: "authenticating", message: "Connecting securely to Telegram..." }
    for (const field of this.#fields) field.value = ""
    this.render()
    try {
      const authenticated = await TelegramService.authenticate(
        { apiId, apiHash, phone },
        {
          code: () => this.requestPrompt("code"),
          password: () => this.requestPrompt("password"),
          invalid: (kind) => {
            this.#error = kind === "code" ? "Incorrect login code" : "Incorrect password"
          },
          codeSent: () => {
            this.#status = "Telegram sent a login code."
          },
        },
        this.#diagnostics,
        this.#authAbort.signal,
      )
      this.#service = authenticated.service
      this.#status = `Signed in as ${authenticated.user.displayName}`
      this.#screen = { kind: "chats" }
      await this.refresh()
    } catch (error) {
      if (this.#closing) return
      this.#error = error instanceof Error ? error.message : "Authentication failed"
      this.#screen = { kind: "credentials" }
    } finally {
      this.#authAbort = null
    }
    this.render()
  }

  private requestPrompt(kind: "code" | "password"): Promise<string> {
    this.#promptValue = ""
    this.#screen = {
      kind: "authenticating",
      prompt: kind,
      message: kind === "code" ? "Enter the code Telegram sent" : "Two-factor authentication",
    }
    this.render()
    return new Promise((resolve) => {
      this.#pendingPrompt = { kind, resolve }
    })
  }

  private async refresh(): Promise<void> {
    if (!this.#service) return
    const generation = ++this.#refreshGeneration
    this.#countAbort?.abort()
    this.#countAbort = new AbortController()
    this.#previewCache.clear()
    this.#preview = []
    this.#analyzed = 0
    this.#status = "Loading Telegram dialogs..."
    this.render()
    try {
      const selectedBefore = new Set(this.#selected)
      const dialogs = await this.#service.getDialogs()
      if (generation !== this.#refreshGeneration) return
      this.#chats = dialogs.map((chat) => ({ ...chat }))
      this.#selected.clear()
      for (const chat of this.#chats) if (selectedBefore.has(chat.id)) this.#selected.add(chat.id)
      this.#cursor = Math.min(this.#cursor, Math.max(this.#chats.length - 1, 0))
      this.#status = `Analyzing 0 / ${this.#chats.length} chats`
      this.render()
      void this.loadPreview()
      await this.#service.countOwnMessages(
        this.#chats,
        (progress) => {
          if (generation !== this.#refreshGeneration) return
          const chat = this.#chats.find((item) => item.id === progress.chatId)
          if (chat) {
            chat.count = progress.count
            if (progress.error) chat.countError = progress.error
            else delete chat.countError
          }
          this.#analyzed = progress.analyzed
          this.#status = `Analyzed ${progress.analyzed} / ${progress.total} chats`
          this.sortChats()
          this.render()
        },
        this.#countAbort.signal,
      )
    } catch (error) {
      if (generation !== this.#refreshGeneration) return
      this.#error = error instanceof Error ? error.message : "Unable to load chats"
    }
    if (generation !== this.#refreshGeneration) return
    this.render()
  }

  private sortChats(): void {
    const focusedId = this.visibleChats()[this.#cursor]?.id
    this.#chats.sort((a, b) => {
      if (a.count === undefined && b.count !== undefined) return 1
      if (a.count !== undefined && b.count === undefined) return -1
      return (b.count ?? -1) - (a.count ?? -1)
    })
    if (focusedId !== undefined) {
      const index = this.visibleChats().findIndex((chat) => chat.id === focusedId)
      if (index >= 0) this.#cursor = index
    }
  }

  private async loadPreview(force = false): Promise<void> {
    const chat = this.visibleChats()[this.#cursor]
    if (!chat || !this.#service) return
    const cached = this.#previewCache.get(chat.id)
    if (cached && !force) {
      this.#preview = cached
      this.#previewLoading = false
      this.render()
      return
    }
    const token = ++this.#previewToken
    this.#previewLoading = true
    this.render()
    try {
      const preview = await this.#service.getRecentMessages(chat)
      this.#previewCache.set(chat.id, preview)
      if (token === this.#previewToken) this.#preview = preview
    } catch (error) {
      if (token === this.#previewToken) {
        this.#preview = []
        this.#error = error instanceof Error ? error.message : "Unable to load preview"
      }
    } finally {
      if (token === this.#previewToken) this.#previewLoading = false
      this.render()
    }
  }

  private async beginDeletion(): Promise<void> {
    if (!this.#service) return
    const chats = this.selectedChats()
      .filter((chat): chat is ChatRow & { count: number } => typeof chat.count === "number")
      .map((chat) => ({ ...chat, count: chat.count }))
    if (chats.length === 0) return
    this.#deleteAbort = new AbortController()
    this.#deleteProgress = null
    this.#screen = { kind: "deleting" }
    this.render()
    const result = await this.#service.deleteOwnMessages(
      chats,
      (progress) => {
        this.#deleteProgress = progress
        this.render()
      },
      this.#deleteAbort.signal,
    )
    this.#selected.clear()
    this.#screen = { kind: "result", result }
    this.render()
  }

  private visibleChats(): ChatRow[] {
    const query = this.#search.trim().toLocaleLowerCase()
    if (!query) return this.#chats
    return this.#chats.filter(
      (chat) =>
        chat.title.toLocaleLowerCase().includes(query) ||
        chat.username?.toLocaleLowerCase().includes(query),
    )
  }

  private selectedChats(): ChatRow[] {
    return this.#chats.filter((chat) => this.#selected.has(chat.id) && (chat.count ?? 0) > 0)
  }

  private selectedTotal(): number {
    return this.selectedChats().reduce((sum, chat) => sum + (chat.count ?? 0), 0)
  }

  private render(): void {
    for (const child of this.renderer.root.getChildren()) child.destroyRecursively()
    if (this.renderer.width < 60 || this.renderer.height < 18) {
      this.renderer.root.add(
        Box(
          { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
          Text({ content: "wipegram needs at least 60 x 18 columns", fg: colors.muted }),
        ),
      )
      return
    }

    const content =
      this.#screen.kind === "credentials"
        ? this.renderCredentials()
        : this.#screen.kind === "authenticating"
          ? this.renderAuthenticating()
          : this.#screen.kind === "chats"
            ? this.renderChats()
            : this.#screen.kind === "confirm"
              ? this.renderConfirmation()
              : this.#screen.kind === "deleting"
                ? this.renderDeleting()
                : this.#screen.kind === "result"
                  ? this.renderResult(this.#screen.result)
                  : this.renderDiagnostics()

    this.renderer.root.add(
      Box(
        {
          width: "100%",
          height: "100%",
          padding: 1,
          flexDirection: "column",
          backgroundColor: colors.background,
        },
        this.header(),
        content,
      ),
    )
  }

  private header() {
    return Box(
      { height: 3, flexDirection: "row", justifyContent: "space-between", paddingX: 1 },
      Text({
        content: "wipegram",
        fg: colors.accent,
        attributes: TextAttributes.BOLD,
      }),
      Text({ content: "EPHEMERAL TELEGRAM CLEANUP", fg: colors.muted }),
    )
  }

  private renderCredentials() {
    const fields = this.#fields.map((field, index) => {
      const active = index === this.#activeField
      const value = field.value
        ? field.masked
          ? "•".repeat(Math.min(field.value.length, 32))
          : field.value
        : field.placeholder
      return Box(
        { flexDirection: "column", gap: 0, marginBottom: 1 },
        Text({ content: field.label.toUpperCase(), fg: active ? colors.accent : colors.muted }),
        Box(
          {
            height: 3,
            borderStyle: "rounded",
            borderColor: active ? colors.accent : colors.border,
            backgroundColor: active ? colors.panelActive : colors.panel,
            paddingX: 1,
          },
          Text({ content: `${value}${active ? "▌" : ""}`, fg: field.value ? colors.text : colors.muted }),
        ),
      )
    })
    return Box(
      { flexGrow: 1, alignItems: "center", justifyContent: "center" },
      Box(
        {
          width: Math.min(64, this.renderer.width - 8),
          flexDirection: "column",
          borderStyle: "rounded",
          borderColor: colors.border,
          backgroundColor: colors.panel,
          padding: 2,
        },
        Text({ content: "Connect your Telegram account", fg: colors.text, attributes: TextAttributes.BOLD }),
        Text({ content: "Nothing entered here is written to disk.", fg: colors.muted, marginBottom: 2 }),
        ...fields,
        Text({ content: "Tab / ↑↓ move   Enter continue   ? diagnostics", fg: colors.muted }),
        ...(this.#error ? [Text({ content: this.#error, fg: colors.danger, marginTop: 1 })] : []),
      ),
    )
  }

  private renderAuthenticating() {
    const prompt = this.#screen.kind === "authenticating" ? this.#screen.prompt : undefined
    const shown = prompt
      ? prompt === "password"
        ? "•".repeat(this.#promptValue.length)
        : this.#promptValue
      : ""
    return Box(
      { flexGrow: 1, alignItems: "center", justifyContent: "center" },
      Box(
        {
          width: 58,
          borderStyle: "rounded",
          borderColor: prompt ? colors.accent : colors.border,
          backgroundColor: colors.panel,
          padding: 2,
          flexDirection: "column",
        },
        Text({ content: this.#screen.kind === "authenticating" ? this.#screen.message : "", fg: colors.text }),
        ...(prompt
          ? [
              Box(
                { height: 3, borderStyle: "rounded", borderColor: colors.accent, paddingX: 1, marginTop: 1 },
                Text({ content: `${shown}▌`, fg: colors.text }),
              ),
              Text({ content: "Paste works   Enter submit", fg: colors.muted, marginTop: 1 }),
            ]
          : [Text({ content: "Waiting for Telegram...", fg: colors.accent, marginTop: 1 })]),
        ...(this.#error ? [Text({ content: this.#error, fg: colors.danger, marginTop: 1 })] : []),
      ),
    )
  }

  private renderChats() {
    const wide = this.renderer.width >= 94
    const visible = this.visibleChats()
    const listHeight = Math.max(7, this.renderer.height - (wide ? 10 : 18))
    const start = Math.max(0, Math.min(this.#cursor - Math.floor(listHeight / 2), visible.length - listHeight))
    const rows = visible.slice(start, start + listHeight).map((chat, offset) => {
      const index = start + offset
      const active = index === this.#cursor
      const count = chat.count === undefined ? "…" : chat.count === null ? "!" : formatNumber(chat.count)
      const selected = this.#selected.has(chat.id) ? "◆" : " "
      const width = wide ? Math.floor((this.renderer.width - 8) * 0.54) : this.renderer.width - 8
      const metadata = `${chat.type}${chat.archived ? " · archived" : ""}`
      const titleWidth = Math.max(12, width - count.length - 6)
      return Box(
        {
          height: 2,
          paddingX: 1,
          flexDirection: "row",
          justifyContent: "space-between",
          backgroundColor: active ? colors.panelActive : "transparent",
        },
        Text({
          content: `${active ? "›" : " "} ${selected} ${truncate(chat.title, titleWidth)}`,
          fg: active ? colors.text : colors.muted,
        }),
        Text({ content: `${metadata}  ${count}`, fg: chat.countError ? colors.danger : colors.accent }),
      )
    })
    const list = Box(
      {
        width: wide ? "55%" : "100%",
        flexGrow: 1,
        borderStyle: "rounded",
        borderColor: colors.border,
        title: this.#searching ? ` Chats · /${this.#search}▌ ` : " Chats ",
        titleColor: this.#searching ? colors.accent : colors.text,
        padding: 1,
        flexDirection: "column",
      },
      ...(rows.length > 0 ? rows : [Text({ content: "No chats match this search.", fg: colors.muted })]),
    )
    const body = Box(
      { flexGrow: 1, flexDirection: wide ? "row" : "column", gap: 1 },
      list,
      this.renderPreview(wide),
    )
    const selected = this.selectedChats().length
    const summary = selected
      ? `${selected} selected · ${formatNumber(this.selectedTotal())} messages`
      : `${visible.length} chats · ${this.#analyzed}/${this.#chats.length} analyzed`
    return Box(
      { flexGrow: 1, flexDirection: "column" },
      body,
      Box(
        { height: 2, paddingX: 1, flexDirection: "row", justifyContent: "space-between" },
        Text({ content: summary, fg: selected ? colors.accent : colors.muted }),
        Text({ content: "↑↓ navigate  Space select  / search  D delete  R refresh  ? logs  Q quit", fg: colors.muted }),
      ),
      Text({ content: this.#status, fg: colors.muted }),
      ...(this.#error ? [Text({ content: this.#error, fg: colors.danger })] : []),
    )
  }

  private renderPreview(wide: boolean) {
    const chat = this.visibleChats()[this.#cursor]
    const height = wide ? "100%" : 7
    if (!chat) {
      return Box(
        { width: wide ? "45%" : "100%", height, borderStyle: "rounded", borderColor: colors.border, padding: 1 },
        Text({ content: "Preview", fg: colors.muted }),
      )
    }
    const messages = this.#preview.slice(wide ? -8 : -2).flatMap((message) => [
      Text({
        content: `${message.own ? "You" : truncate(message.author, 18)} · ${formatTime(message.sentAt)}`,
        fg: message.own ? colors.own : colors.accent,
      }),
      Text({ content: truncate(message.content, wide ? 48 : this.renderer.width - 12), fg: colors.text }),
    ])
    return Box(
      {
        width: wide ? "45%" : "100%",
        height,
        borderStyle: "rounded",
        borderColor: colors.border,
        title: ` Preview · ${truncate(chat.title, 24)} `,
        titleColor: colors.text,
        padding: 1,
        flexDirection: "column",
      },
      ...(this.#previewLoading
        ? [Text({ content: "Loading recent context...", fg: colors.muted })]
        : messages.length > 0
          ? messages
          : [Text({ content: "No recent messages to preview.", fg: colors.muted })]),
    )
  }

  private renderConfirmation() {
    const chats = this.selectedChats()
    return this.centeredPanel(
      "Delete your messages?",
      Text({
        content: "Telegram will be asked to revoke these messages for everyone where permitted.",
        fg: colors.muted,
      }),
      ...chats.slice(0, 10).map((chat) =>
        Box(
          { flexDirection: "row", justifyContent: "space-between" },
          Text({ content: truncate(chat.title, 38), fg: colors.text }),
          Text({ content: formatNumber(chat.count ?? 0), fg: colors.accent }),
        ),
      ),
      ...(chats.length > 10 ? [Text({ content: `and ${chats.length - 10} more chats`, fg: colors.muted })] : []),
      Text({ content: `Total  ${formatNumber(this.selectedTotal())}`, fg: colors.danger, attributes: TextAttributes.BOLD }),
      Text({ content: "Enter delete permanently   Esc cancel", fg: colors.muted }),
    )
  }

  private renderDeleting() {
    const progress = this.#deleteProgress
    const ratio = progress && progress.expected > 0 ? progress.processed / progress.expected : 0
    const barWidth = 36
    const filled = Math.min(barWidth, Math.round(ratio * barWidth))
    return this.centeredPanel(
      "Deleting your messages",
      Text({ content: progress?.chatTitle ?? "Preparing first batch...", fg: colors.text }),
      Text({ content: `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`, fg: colors.accent }),
      Text({
        content: `${formatNumber(progress?.processed ?? 0)} / ${formatNumber(progress?.expected ?? this.selectedTotal())}`,
        fg: colors.muted,
      }),
      Text({ content: `Deleted  ${formatNumber(progress?.deleted ?? 0)}`, fg: colors.own }),
      Text({ content: `Failed   ${formatNumber(progress?.failed ?? 0)}`, fg: progress?.failed ? colors.danger : colors.muted }),
      Text({ content: "Esc / Ctrl+C stop after current request", fg: colors.muted }),
    )
  }

  private renderResult(result: DeleteResult) {
    return this.centeredPanel(
      result.cancelled ? "Cleanup stopped" : "Cleanup complete",
      Text({ content: `Deleted  ${formatNumber(result.deleted)}`, fg: colors.own }),
      Text({ content: `Failed   ${formatNumber(result.failed)}`, fg: result.failed ? colors.danger : colors.muted }),
      Text({ content: `Chats with failures  ${result.failures.size}`, fg: colors.muted }),
      ...(result.failures.size > 0
        ? Array.from(result.failures.values())
            .slice(0, 3)
            .map((message) => Text({ content: message, fg: colors.danger }))
        : []),
      Text({ content: "Enter refresh chats   ? diagnostics   Q quit", fg: colors.muted }),
    )
  }

  private renderDiagnostics() {
    const entries = this.#diagnostics.snapshot().slice(-Math.max(5, this.renderer.height - 12))
    return Box(
      {
        flexGrow: 1,
        borderStyle: "rounded",
        borderColor: colors.border,
        title: " Sanitized in-memory diagnostics ",
        titleColor: colors.text,
        padding: 1,
        flexDirection: "column",
      },
      Text({
        content: "No credentials, phone numbers, peer IDs, message content, or session material are recorded.",
        fg: colors.muted,
      }),
      ...entries.map((entry) =>
        Text({
          content: `${formatTime(entry.at)}  ${entry.operation.padEnd(20)} ${entry.outcome.padEnd(10)} ${entry.durationMs ?? "-"}ms  count=${entry.count ?? "-"}  code=${entry.code ?? "-"}`,
          fg: entry.level === "error" ? colors.danger : entry.level === "warn" ? colors.accent : colors.text,
        }),
      ),
      Text({ content: "Esc / Enter return", fg: colors.muted, marginTop: 1 }),
    )
  }

  private centeredPanel(title: string, ...children: VChild[]) {
    return Box(
      { flexGrow: 1, alignItems: "center", justifyContent: "center" },
      Box(
        {
          width: Math.min(66, this.renderer.width - 8),
          borderStyle: "rounded",
          borderColor: colors.border,
          title: ` ${title} `,
          titleColor: colors.text,
          backgroundColor: colors.panel,
          padding: 2,
          gap: 1,
          flexDirection: "column",
        },
        ...children,
      ),
    )
  }

  private async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    this.#refreshGeneration += 1
    this.#pendingPrompt?.resolve("")
    this.#pendingPrompt = null
    this.#authAbort?.abort()
    this.#countAbort?.abort()
    this.#deleteAbort?.abort()
    try {
      await this.#service?.disconnect()
    } finally {
      this.#service = null
      this.#promptValue = ""
      for (const field of this.#fields) field.value = ""
      this.#previewCache.clear()
      this.#chats = []
      for (const signal of this.#signals) process.removeListener(signal, this.#signalHandler)
      this.renderer.destroy()
    }
  }
}

function isPrintable(key: KeyEvent): boolean {
  return !key.ctrl && !key.meta && key.sequence.length > 0 && key.sequence >= " "
}

function truncate(value: string, width: number): string {
  if (width <= 1) return ""
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value)
}
