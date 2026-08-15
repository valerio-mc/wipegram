import {
  Box,
  BoxRenderable,
  ImageRenderable,
  Text,
  TextAttributes,
  TextRenderable,
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
  type MessagePreviewPage,
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

interface PreviewState extends MessagePreviewPage {
  cursor: number
}

type Screen =
  | { kind: "credentials" }
  | { kind: "authenticating"; prompt?: "code" | "password"; message: string }
  | { kind: "chats" }
  | { kind: "confirm" }
  | { kind: "deleting" }
  | { kind: "result"; result: DeleteResult }
  | { kind: "diagnostics"; previous: "credentials" | "chats" }

type PendingPrompt = (value: string) => void

interface ChatLayout {
  wide: boolean
  showPreview: boolean
  bodyHeight: number
  listHeight: number
  pageSize: number
}

const CHAT_ROW_HEIGHT = 2
const LIST_CHROME_HEIGHT = 4
const STACKED_PREVIEW_HEIGHT = 7
const PREVIEW_PAGE_SIZE = 15
const SHUTDOWN_DEADLINE_MS = 5_000
const LOGO_SOURCE = new URL("../wipegram.png", import.meta.url)

export function calculateChatLayout(width: number, height: number, hasError: boolean): ChatLayout {
  const wide = width >= 94
  const footerHeight = 2 + (hasError ? 1 : 0)
  const availableHeight = Math.max(1, height - 2 - footerHeight)
  const showPreview = wide || availableHeight >= 16
  const listHeight = Math.max(
    1,
    wide || !showPreview ? availableHeight : availableHeight - STACKED_PREVIEW_HEIGHT - 1,
  )
  const pageSize = Math.max(1, Math.floor((listHeight - LIST_CHROME_HEIGHT) / CHAT_ROW_HEIGHT))
  return { wide, showPreview, bodyHeight: availableHeight, listHeight, pageSize }
}

export class WipegramApp {
  readonly #diagnostics = new Diagnostics()
  readonly #fields: Field[] = [
    { label: "API ID", placeholder: "12345678", value: "", masked: false },
    { label: "API hash", placeholder: "From my.telegram.org", value: "", masked: true },
    { label: "Phone", placeholder: "+39 333 123 4567", value: "", masked: false },
  ]
  readonly #previewCache = new Map<number, PreviewState>()
  readonly #selected = new Set<number>()
  #sizeStage!: BoxRenderable
  #onboardingStage!: BoxRenderable
  #onboardingPanel!: BoxRenderable
  #logoRail!: BoxRenderable
  #logo!: ImageRenderable
  #logoFallback!: BoxRenderable
  #formHost!: BoxRenderable
  #operationalStage!: BoxRenderable
  #screen: Screen = { kind: "credentials" }
  #service: TelegramService | null = null
  #activeField = 0
  #promptValue = ""
  #pendingPrompt: PendingPrompt | null = null
  #error = ""
  #chats: ChatRow[] = []
  #analyzed = 0
  #cursor = 0
  #search = ""
  #searching = false
  #preview: MessagePreview[] = []
  #previewNext: MessagePreviewPage["next"]
  #previewCursor = 0
  #previewFocused = false
  #previewError = ""
  #previewLoading = false
  #previewNavigating = false
  #previewPendingDelta = 0
  #previewToken = 0
  #countAbort: AbortController | null = null
  #authAbort: AbortController | null = null
  #deleteAbort: AbortController | null = null
  #deleteProgress: DeleteProgress | null = null
  #refreshing = false
  #refreshPending = false
  #closing = false
  #refreshGeneration = 0
  readonly #signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]
  readonly #signalHandler = (): void => {
    void this.close()
  }

  constructor(private readonly renderer: CliRenderer) {}

  async start(): Promise<void> {
    this.renderer.setTerminalTitle("wipegram")
    this.initializeShell()
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => void this.onKey(key))
    this.renderer.keyInput.on("paste", (event: PasteEvent) => this.onPaste(event))
    this.renderer.on("resize", () => this.render())
    for (const signal of this.#signals) process.once(signal, this.#signalHandler)
    this.render()
  }

  private async onKey(key: KeyEvent): Promise<void> {
    if (key.eventType === "release") return
    const textEntry =
      this.#screen.kind === "credentials" ||
      this.#screen.kind === "authenticating" ||
      (this.#screen.kind === "chats" && this.#searching)
    if ((key.ctrl && key.name === "c") || (key.name.toLowerCase() === "q" && !textEntry)) {
      if (this.#screen.kind === "deleting") {
        this.#deleteAbort?.abort()
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
      const resolve = this.#pendingPrompt
      this.#promptValue = ""
      this.#pendingPrompt = null
      this.#screen = { kind: "authenticating", message: "Verifying with Telegram..." }
      resolve(value)
    } else if (isPrintable(key)) {
      this.#promptValue += key.sequence
    }
    this.render()
  }

  private async handleChatsKey(key: KeyEvent): Promise<void> {
    if (key.ctrl && key.name.toLowerCase() === "r") {
      await this.refresh()
      return
    }

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

    if (this.#previewFocused) {
      if (key.name === "escape" || key.name === "return") {
        this.#previewFocused = false
      } else if (key.name === "up" || key.name === "k") {
        await this.movePreviewCursor(-1)
      } else if (key.name === "down" || key.name === "j") {
        await this.movePreviewCursor(1)
      } else if (key.name === "pageup") {
        await this.movePreviewCursor(-this.previewPageSize())
      } else if (key.name === "pagedown") {
        await this.movePreviewCursor(this.previewPageSize())
      }
      this.render()
      return
    }

    const visible = this.visibleChats()
    const pageSize = this.chatLayout().pageSize
    if (key.name === "up" || key.name === "k") {
      this.moveChatCursor(-1)
    } else if (key.name === "down" || key.name === "j") {
      this.moveChatCursor(1)
    } else if (key.name === "pageup") {
      this.moveChatCursor(-pageSize)
    } else if (key.name === "pagedown") {
      this.moveChatCursor(pageSize)
    } else if (key.name === "home") {
      this.moveChatCursor(-this.#cursor)
    } else if (key.name === "end") {
      this.moveChatCursor(visible.length - 1 - this.#cursor)
    } else if (key.name === "space") {
      const chat = visible[this.#cursor]
      if (chat && this.#selected.has(chat.id)) {
        this.#selected.delete(chat.id)
      } else if (chat && typeof chat.count === "number" && chat.count > 0) {
        this.#selected.add(chat.id)
      }
    } else if (key.name === "return") {
      if (this.chatLayout().showPreview) this.#previewFocused = true
    } else if (key.name === "/") {
      this.#searching = true
    } else if (key.name.toLowerCase() === "d" && this.selectedChats().length > 0) {
      this.#screen = { kind: "confirm" }
    } else if (key.name === "?" || (key.shift && key.name === "/")) {
      this.#screen = { kind: "diagnostics", previous: "chats" }
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
      this.#service = await TelegramService.authenticate(
        { apiId, apiHash, phone },
        {
          code: () => this.requestPrompt("code"),
          password: () => this.requestPrompt("password"),
          invalid: (kind) => {
            this.#error = kind === "code" ? "Incorrect login code" : "Incorrect password"
          },
        },
        this.#diagnostics,
        this.#authAbort.signal,
      )
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
      this.#pendingPrompt = resolve
    })
  }

  private async refresh(): Promise<void> {
    this.#refreshPending = true
    if (this.#refreshing) {
      this.#refreshGeneration += 1
      this.#countAbort?.abort()
      return
    }
    this.#refreshing = true
    try {
      while (this.#refreshPending && !this.#closing) {
        this.#refreshPending = false
        await this.loadChats()
      }
    } finally {
      this.#refreshing = false
    }
  }

  private async loadChats(): Promise<void> {
    if (!this.#service) return
    this.#error = ""
    const generation = ++this.#refreshGeneration
    this.#countAbort?.abort()
    this.#countAbort = new AbortController()
    this.#previewCache.clear()
    this.#previewToken += 1
    this.#preview = []
    this.#previewNext = undefined
    this.#previewCursor = 0
    this.#previewFocused = false
    this.#previewError = ""
    this.#previewLoading = false
    this.#previewPendingDelta = 0
    this.#analyzed = 0
    this.render()
    try {
      const selectedBefore = new Set(this.#selected)
      const dialogs = await this.#service.getDialogs()
      if (generation !== this.#refreshGeneration) return
      this.#chats = dialogs.map((chat) => ({ ...chat }))
      this.#selected.clear()
      for (const chat of this.#chats) if (selectedBefore.has(chat.id)) this.#selected.add(chat.id)
      this.#cursor = Math.min(this.#cursor, Math.max(this.#chats.length - 1, 0))
      this.render()
      void this.loadPreview()
      await this.#service.countCleanupMessages(
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
          this.sortChats()
          this.render()
          if (progress.analyzed === progress.total) void this.loadPreview()
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

  private async loadPreview(): Promise<void> {
    const chat = this.visibleChats()[this.#cursor]
    if (!chat || !this.#service) return
    const token = ++this.#previewToken
    const cached = this.#previewCache.get(chat.id)
    if (cached) {
      this.applyPreviewState(cached)
      this.#previewError = ""
      this.#previewLoading = false
      this.render()
      return
    }
    this.#preview = []
    this.#previewNext = undefined
    this.#previewCursor = 0
    this.#previewError = ""
    this.#previewLoading = true
    this.render()
    try {
      const page = await this.#service.getRecentMessages(chat, PREVIEW_PAGE_SIZE)
      const state: PreviewState = {
        ...page,
        cursor: Math.max(0, page.messages.length - 1),
      }
      if (token === this.#previewToken) {
        this.#previewCache.set(chat.id, state)
        this.applyPreviewState(state)
      }
    } catch (error) {
      if (token === this.#previewToken) {
        this.#preview = []
        this.#previewNext = undefined
        this.#previewCursor = 0
        this.#previewError = error instanceof Error ? error.message : "Unable to load preview"
      }
    } finally {
      if (token === this.#previewToken) this.#previewLoading = false
      this.render()
    }
  }

  private applyPreviewState(state: PreviewState): void {
    this.#preview = state.messages
    this.#previewNext = state.next
    this.#previewCursor = state.cursor
  }

  private previewPageSize(): number {
    const height = this.chatLayout().wide ? this.chatLayout().bodyHeight : STACKED_PREVIEW_HEIGHT
    return Math.max(1, Math.floor((height - LIST_CHROME_HEIGHT) / 2))
  }

  private async movePreviewCursor(delta: number): Promise<void> {
    const chatId = this.visibleChats()[this.#cursor]?.id
    if (chatId === undefined) return
    this.#previewPendingDelta += delta
    if (this.#previewNavigating) return
    this.#previewNavigating = true
    try {
      while (this.#previewPendingDelta !== 0) {
        const pending = this.#previewPendingDelta
        this.#previewPendingDelta = 0
        let cursor = this.#previewCursor
        if (pending < 0 && cursor + pending < 0 && this.#previewNext) {
          cursor += await this.loadOlderPreview()
        }
        if (this.visibleChats()[this.#cursor]?.id !== chatId) {
          this.#previewPendingDelta = 0
          return
        }
        this.#previewCursor = Math.max(
          0,
          Math.min(Math.max(this.#preview.length - 1, 0), cursor + pending),
        )
        this.updateCachedPreviewCursor()
      }
    } finally {
      this.#previewNavigating = false
    }
  }

  private async loadOlderPreview(): Promise<number> {
    const chat = this.visibleChats()[this.#cursor]
    const offset = this.#previewNext
    if (!chat || !offset || !this.#service || this.#previewLoading) return 0
    const token = ++this.#previewToken
    this.#previewError = ""
    this.#previewLoading = true
    this.render()
    try {
      const page = await this.#service.getRecentMessages(chat, PREVIEW_PAGE_SIZE, offset)
      if (token !== this.#previewToken) return 0
      const loadedIds = new Set(this.#preview.map((message) => message.id))
      const older = page.messages.filter((message) => !loadedIds.has(message.id))
      this.#preview = [...older, ...this.#preview]
      this.#previewNext = page.next
      return older.length
    } catch (error) {
      if (token === this.#previewToken) {
        this.#previewError = error instanceof Error ? error.message : "Unable to load older messages"
      }
    } finally {
      if (token === this.#previewToken) this.#previewLoading = false
    }
    return 0
  }

  private updateCachedPreviewCursor(): void {
    const chat = this.visibleChats()[this.#cursor]
    if (!chat) return
    this.#previewCache.set(chat.id, {
      messages: this.#preview,
      ...(this.#previewNext ? { next: this.#previewNext } : {}),
      cursor: this.#previewCursor,
    })
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
    const result = await this.#service.deleteSelectedMessages(
      chats,
      (progress) => {
        this.#deleteProgress = progress
        this.render()
      },
      this.#deleteAbort.signal,
    )
    this.#selected.clear()
    this.#screen = { kind: "result", result }
  }

  private visibleChats(): ChatRow[] {
    const query = this.#search.trim().toLocaleLowerCase()
    const hideEmpty = this.#analyzed === this.#chats.length
    return this.#chats.filter(
      (chat) =>
        (!hideEmpty || chat.count !== 0) &&
        (!query ||
        chat.title.toLocaleLowerCase().includes(query) ||
          chat.username?.toLocaleLowerCase().includes(query)),
    )
  }

  private hiddenEmptyCount(): number {
    if (this.#analyzed !== this.#chats.length) return 0
    return this.#chats.reduce((total, chat) => total + (chat.count === 0 ? 1 : 0), 0)
  }

  private chatLayout(): ChatLayout {
    return calculateChatLayout(this.renderer.width, this.renderer.height, Boolean(this.#error))
  }

  private moveChatCursor(delta: number): void {
    const lastIndex = Math.max(this.visibleChats().length - 1, 0)
    this.#cursor = Math.max(0, Math.min(lastIndex, this.#cursor + delta))
    void this.loadPreview()
  }

  private selectedChats(): ChatRow[] {
    return this.#chats.filter((chat) => this.#selected.has(chat.id) && (chat.count ?? 0) > 0)
  }

  private selectedTotal(): number {
    return this.selectedChats().reduce((sum, chat) => sum + (chat.count ?? 0), 0)
  }

  private render(): void {
    if (this.#closing) return
    const tooSmall = this.renderer.width < 60 || this.renderer.height < 18
    const onboarding = this.#screen.kind === "credentials" || this.#screen.kind === "authenticating"
    this.#sizeStage.visible = tooSmall
    this.#onboardingStage.visible = !tooSmall && onboarding
    this.#operationalStage.visible = !tooSmall && !onboarding
    if (tooSmall) return

    if (onboarding) this.renderOnboarding()
    else {
      this.clearHost(this.#operationalStage)
      const content =
        this.#screen.kind === "chats"
          ? this.renderChats()
          : this.#screen.kind === "confirm"
            ? this.renderConfirmation()
            : this.#screen.kind === "deleting"
              ? this.renderDeleting()
              : this.#screen.kind === "result"
                ? this.renderResult(this.#screen.result)
                : this.renderDiagnostics()
      this.#operationalStage.add(content)
    }
  }

  private initializeShell(): void {
    const appShell = new BoxRenderable(this.renderer, {
      id: "app-shell",
      width: "100%",
      height: "100%",
      padding: 1,
      backgroundColor: colors.background,
    })
    this.#sizeStage = new BoxRenderable(this.renderer, {
      id: "size-stage",
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
    })
    this.#sizeStage.add(Text({ content: "wipegram needs at least 60 x 18 columns", fg: colors.muted }))

    this.#onboardingStage = new BoxRenderable(this.renderer, {
      id: "onboarding-stage",
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
    })
    this.#onboardingPanel = new BoxRenderable(this.renderer, {
      id: "onboarding-panel",
      borderStyle: "rounded",
      borderColor: colors.border,
      backgroundColor: colors.panel,
      overflow: "hidden",
    })
    this.#logoRail = new BoxRenderable(this.renderer, {
      id: "logo-rail",
      width: 34,
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.panel,
    })
    this.#logoFallback = new BoxRenderable(this.renderer, {
      id: "logo-fallback",
      width: "100%",
      alignItems: "center",
      flexDirection: "column",
      visible: false,
    })
    this.#logoFallback.add(
      new TextRenderable(this.renderer, {
        content: "wipegram",
        fg: colors.accent,
        attributes: TextAttributes.BOLD,
      }),
    )
    this.#logoFallback.add(
      new TextRenderable(this.renderer, {
        content: "Private Telegram cleanup",
        fg: colors.muted,
        marginTop: 1,
      }),
    )
    this.#logo = new ImageRenderable(this.renderer, {
      id: "wipegram-logo",
      source: LOGO_SOURCE,
      width: 28,
      height: 14,
      fit: "fit",
      protocol: "auto",
      onLoad: () => {
        this.#diagnostics.record({
          level: "info",
          operation: "ui.logo",
          outcome: "ready",
          code: this.#logo.effectiveProtocol.toUpperCase(),
        })
      },
      onError: () => {
        this.#logo.visible = false
        this.#logoFallback.visible = true
        this.#diagnostics.record({
          level: "warn",
          operation: "ui.logo",
          outcome: "unavailable",
          code: "IMAGE_LOAD_FAILED",
        })
      },
    })
    this.#logoRail.add(this.#logo)
    this.#logoRail.add(this.#logoFallback)
    this.#formHost = new BoxRenderable(this.renderer, {
      id: "form-host",
      height: "100%",
      flexDirection: "column",
    })
    this.#onboardingPanel.add(this.#logoRail)
    this.#onboardingPanel.add(this.#formHost)
    this.#onboardingStage.add(this.#onboardingPanel)

    this.#operationalStage = new BoxRenderable(this.renderer, {
      id: "operational-stage",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    })
    appShell.add(this.#sizeStage)
    appShell.add(this.#onboardingStage)
    appShell.add(this.#operationalStage)
    this.renderer.root.add(appShell)
  }

  private renderOnboarding(): void {
    const spacious = this.renderer.width >= 104 && this.renderer.height >= 30
    const panelWidth = spacious ? 100 : Math.min(88, this.renderer.width - 4)
    this.#onboardingPanel.width = panelWidth
    this.#onboardingPanel.height = spacious ? 26 : 16
    this.#onboardingPanel.flexDirection = "row"
    this.#logoRail.width = spacious ? 34 : 12
    this.#logo.width = spacious ? 28 : 10
    this.#logo.height = spacious ? 14 : 5
    this.#formHost.width = spacious ? 64 : panelWidth - 14
    this.#formHost.padding = spacious ? 2 : 1
    this.clearHost(this.#formHost)
    const content = this.#screen.kind === "credentials" ? this.renderCredentialFields(spacious) : this.renderAuthenticationPrompt()
    for (const child of content) this.#formHost.add(child)
  }

  private renderCredentialFields(spacious: boolean): VChild[] {
    const fields = this.#fields.map((field, index) => {
      const active = index === this.#activeField
      const value = field.value
        ? field.masked
          ? "•".repeat(Math.min(field.value.length, 32))
          : field.value
        : field.placeholder
      const input = Box(
        {
          height: 3,
          borderStyle: "rounded",
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: active ? colors.panelActive : colors.panel,
          paddingX: 1,
          ...(spacious ? {} : { title: field.label.toUpperCase(), titleColor: active ? colors.accent : colors.muted }),
        },
        Text({ content: `${value}${active ? "▌" : ""}`, fg: field.value ? colors.text : colors.muted }),
      )
      return spacious
        ? Box(
            { flexDirection: "column", marginBottom: 1 },
            Text({ content: field.label.toUpperCase(), fg: active ? colors.accent : colors.muted }),
            input,
          )
        : input
    })
    return [
      Text({ content: "Connect your Telegram account", fg: colors.text, attributes: TextAttributes.BOLD }),
      Text({
        content:
          this.#error ||
          (spacious
            ? "Credentials are memory-only; discarded on exit."
            : "Memory-only; discarded on exit."),
        fg: this.#error ? colors.danger : colors.muted,
        marginBottom: spacious ? 2 : 0,
      }),
      ...fields,
      Text({
        content: spacious
          ? "Tab / ↑↓ move · ↵ continue · ? diagnostics"
          : "Tab/↑↓ move · ↵ continue · ? logs",
        fg: colors.muted,
      }),
    ]
  }

  private renderAuthenticationPrompt(): VChild[] {
    const prompt = this.#screen.kind === "authenticating" ? this.#screen.prompt : undefined
    const shown = prompt
      ? prompt === "password"
        ? "•".repeat(this.#promptValue.length)
        : this.#promptValue
      : ""
    return [
      Text({ content: this.#screen.kind === "authenticating" ? this.#screen.message : "", fg: colors.text, attributes: TextAttributes.BOLD }),
      ...(prompt
        ? [
            Box(
              { height: 3, borderStyle: "rounded", borderColor: colors.accent, paddingX: 1, marginTop: 1 },
              Text({ content: `${shown}▌`, fg: colors.text }),
            ),
            ...(this.#error ? [Text({ content: this.#error, fg: colors.danger, marginTop: 1 })] : []),
            Text({ content: "Paste works · ↵ submit", fg: colors.muted, marginTop: 1 }),
          ]
        : [Text({ content: "Waiting for Telegram...", fg: colors.accent, marginTop: 1 })]),
      ...(!prompt && this.#error ? [Text({ content: this.#error, fg: colors.danger, marginTop: 1 })] : []),
    ]
  }

  private clearHost(host: BoxRenderable): void {
    for (const child of host.getChildren()) child.destroyRecursively()
  }

  private renderChats() {
    const layout = this.chatLayout()
    if (!layout.showPreview) this.#previewFocused = false
    const { wide } = layout
    const visible = this.visibleChats()
    const selected = this.selectedChats().length
    const hiddenEmpty = this.hiddenEmptyCount()
    const stats = selected
      ? `${selected} selected · ${formatNumber(this.selectedTotal())} msgs`
      : `${visible.length} shown · ${this.#analyzed}/${this.#chats.length} scanned${hiddenEmpty ? ` · ${hiddenEmpty} hidden` : ""}`
    const listTitleWidth = wide
      ? Math.floor((this.renderer.width - 3) * 0.55) - 4
      : this.renderer.width - 6
    const titleBase = `Chats · ${stats}`
    const searchWidth = Math.max(6, Math.min(24, Math.floor(listTitleWidth * 0.4)))
    const search = `/${truncateStart(this.#search, searchWidth - 2)}▌`
    const listTitle = this.#searching
      ? `${truncate(titleBase, Math.max(8, listTitleWidth - search.length - 3))} · ${search}`
      : titleBase
    this.#cursor = Math.min(this.#cursor, Math.max(visible.length - 1, 0))
    const start = Math.max(
      0,
      Math.min(this.#cursor - Math.floor(layout.pageSize / 2), visible.length - layout.pageSize),
    )
    const rows = visible.slice(start, start + layout.pageSize).map((chat, offset) => {
      const index = start + offset
      const active = index === this.#cursor
      const count = chat.count === undefined ? "…" : chat.count === null ? "!" : formatNumber(chat.count)
      const cleanupCount = `${chat.deletionScope === "history" ? "all" : "own"} ${count}`
      const selected = this.#selected.has(chat.id) ? "◆" : " "
      const width = wide ? Math.floor((this.renderer.width - 8) * 0.54) : this.renderer.width - 8
      const metadata = `${chat.type}${chat.archived ? " · archived" : ""}`
      const titleWidth = Math.max(12, width - cleanupCount.length - 6)
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
        Text({ content: `${metadata}  ${cleanupCount}`, fg: chat.countError ? colors.danger : colors.accent }),
      )
    })
    const list = Box(
      {
        width: wide ? "55%" : "100%",
        height: layout.listHeight,
        minHeight: 0,
        overflow: "hidden",
        borderStyle: "rounded",
        borderColor: colors.border,
        title: ` ${truncate(listTitle, Math.max(10, listTitleWidth))} `,
        titleColor: this.#searching || selected ? colors.accent : colors.text,
        padding: 1,
        flexDirection: "column",
        onMouseScroll: (event) => {
          const direction = event.scroll?.direction
          if (direction !== "up" && direction !== "down") return
          this.#previewFocused = false
          const amount = Math.min(5, Math.max(1, Math.round(event.scroll?.delta ?? 1)))
          this.moveChatCursor(direction === "down" ? amount : -amount)
          event.stopPropagation()
          this.render()
        },
      },
      ...(rows.length > 0 ? rows : [Text({ content: "No chats match this search.", fg: colors.muted })]),
    )
    const body = Box(
      { height: layout.bodyHeight, minHeight: 0, overflow: "hidden", flexDirection: wide ? "row" : "column", gap: 1 },
      list,
      ...(layout.showPreview ? [this.renderPreview(wide)] : []),
    )
    const controls = this.#previewFocused
      ? wide
        ? "Preview · ↑↓ scroll · PgUp/PgDn page · Esc/↵ return · Q/Ctrl+C quit"
        : "Preview · ↑↓ scroll · Esc/↵ return · Q/Ctrl+C quit"
      : this.renderer.width >= 150
        ? "↑↓ move · PgUp/PgDn page · ↵ preview · Space select · / search · D delete · Ctrl+R refresh · ? logs · Q/Ctrl+C quit"
        : wide
          ? "↑↓ move · ↵ preview · Space select · / search · D delete · Ctrl+R refresh · Q/Ctrl+C quit"
          : layout.showPreview
            ? "↑↓ move · ↵ preview · Space select · Ctrl+R · Q/Ctrl+C"
            : "↑↓ move · Space select · Ctrl+R · Q/Ctrl+C"
    return Box(
      { flexGrow: 1, flexDirection: "column" },
      body,
      ...(this.#error ? [Text({ content: this.#error, fg: colors.danger })] : []),
      Box(
        {
          height: 2,
          flexShrink: 0,
          paddingTop: 1,
          alignItems: "center",
          justifyContent: "center",
        },
        Text({ content: truncate(controls, this.renderer.width - 4), fg: colors.muted }),
      ),
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
    const pageSize = this.previewPageSize()
    const start = Math.max(
      0,
      Math.min(this.#previewCursor - Math.floor(pageSize / 2), this.#preview.length - pageSize),
    )
    const messages = this.#preview.slice(start, start + pageSize).flatMap((message, offset) => [
      Text({
        content: `${this.#previewFocused && start + offset === this.#previewCursor ? "› " : "  "}${message.own ? "You" : truncate(message.author, 18)} · ${formatTime(message.sentAt)}`,
        fg: message.own ? colors.own : colors.accent,
      }),
      Text({ content: truncate(message.content, wide ? 48 : this.renderer.width - 12), fg: colors.text }),
    ])
    return Box(
      {
        width: wide ? "45%" : "100%",
        height,
        borderStyle: "rounded",
        borderColor: this.#previewFocused ? colors.accent : colors.border,
        title: ` Preview · ${truncate(chat.title, 20)}${this.#previewLoading && this.#preview.length ? " · loading older…" : this.#previewError && this.#preview.length ? " · history unavailable" : this.#previewFocused ? this.#previewNext ? " · ↑ older" : " · focused" : ""} `,
        titleColor: this.#previewError && this.#preview.length ? colors.danger : this.#previewFocused ? colors.accent : colors.text,
        padding: 1,
        flexDirection: "column",
        overflow: "hidden",
        onMouseDown: (event) => {
          this.#previewFocused = true
          event.stopPropagation()
          this.render()
        },
        onMouseScroll: (event) => {
          const direction = event.scroll?.direction
          if (direction !== "up" && direction !== "down") return
          this.#previewFocused = true
          void this.movePreviewCursor(direction === "up" ? -1 : 1).then(() => this.render())
          event.stopPropagation()
        },
      },
      ...(this.#previewLoading && !this.#preview.length
        ? [Text({ content: "Loading recent context...", fg: colors.muted })]
        : this.#previewError && !messages.length
          ? [Text({ content: this.#previewError, fg: colors.danger })]
        : messages.length > 0
          ? messages
          : [Text({ content: "No recent messages to preview.", fg: colors.muted })]),
    )
  }

  private renderConfirmation() {
    const chats = this.selectedChats()
    return this.centeredPanel(
      "Delete selected history?",
      Text({
        content: "One-to-one chats: delete the full conversation for both people.",
        fg: colors.muted,
      }),
      Text({
        content: "Groups and channels: delete only messages you sent.",
        fg: colors.muted,
      }),
      ...chats.slice(0, 10).map((chat) =>
        Box(
          { flexDirection: "row", justifyContent: "space-between" },
          Text({ content: truncate(chat.title, 38), fg: colors.text }),
          Text({
            content: `${chat.deletionScope === "history" ? "all" : "own"} · ${formatNumber(chat.count ?? 0)}`,
            fg: colors.accent,
          }),
        ),
      ),
      ...(chats.length > 10 ? [Text({ content: `and ${chats.length - 10} more chats`, fg: colors.muted })] : []),
      Text({ content: `Messages affected  ${formatNumber(this.selectedTotal())}`, fg: colors.danger, attributes: TextAttributes.BOLD }),
      Text({ content: "↵ delete permanently · Esc cancel", fg: colors.muted }),
    )
  }

  private renderDeleting() {
    const progress = this.#deleteProgress
    const ratio = progress && progress.expected > 0 ? progress.processed / progress.expected : 0
    const barWidth = 36
    const filled = Math.min(barWidth, Math.round(ratio * barWidth))
    return this.centeredPanel(
      "Deleting selected history",
      Text({ content: progress?.chatTitle ?? "Preparing first batch...", fg: colors.text }),
      Text({ content: `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`, fg: colors.accent }),
      Text({
        content: `${formatNumber(progress?.processed ?? 0)} / ${formatNumber(progress?.expected ?? this.selectedTotal())}`,
        fg: colors.muted,
      }),
      Text({ content: `Affected  ${formatNumber(progress?.deleted ?? 0)}`, fg: colors.own }),
      Text({ content: `Unconfirmed  ${formatNumber(progress?.uncertain ?? 0)}`, fg: progress?.uncertain ? colors.accent : colors.muted }),
      Text({ content: `Failed   ${formatNumber(progress?.failed ?? 0)}`, fg: progress?.failed ? colors.danger : colors.muted }),
      Text({ content: "Esc / Ctrl+C stop after current request", fg: colors.muted }),
    )
  }

  private renderResult(result: DeleteResult) {
    return this.centeredPanel(
      result.cancelled ? "Cleanup stopped" : "Cleanup complete",
      Text({ content: `Affected  ${formatNumber(result.deleted)}`, fg: colors.own }),
      Text({ content: `Unconfirmed  ${formatNumber(result.uncertain)}`, fg: result.uncertain ? colors.accent : colors.muted }),
      Text({ content: `Failed   ${formatNumber(result.failed)}`, fg: result.failed ? colors.danger : colors.muted }),
      Text({ content: `Chats with failures  ${result.failures.size}`, fg: colors.muted }),
      ...(result.failures.size > 0
        ? Array.from(result.failures.values())
            .slice(0, 3)
            .map((message) => Text({ content: message, fg: colors.danger }))
        : []),
      Text({ content: "↵ refresh chats · ? diagnostics · Q quit", fg: colors.muted }),
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
      Text({ content: "Esc / ↵ return", fg: colors.muted, marginTop: 1 }),
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
    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS)
    forceExit.unref()
    this.#refreshGeneration += 1
    this.#previewToken += 1
    this.#pendingPrompt?.("")
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

function truncateStart(value: string, width: number): string {
  if (width <= 1) return ""
  return value.length <= width ? value : `…${value.slice(1 - width)}`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value)
}
