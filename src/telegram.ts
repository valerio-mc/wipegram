import {
  MemoryStorage,
  TelegramClient,
  networkMiddlewares,
  tl,
  type Dialog,
  type InputPeerLike,
  type Message,
} from "@mtcute/bun"
import type { Diagnostics } from "./diagnostics"

interface HistoryOffset {
  id: number
  date: number
}

interface TelegramCredentials {
  apiId: number
  apiHash: string
  phone: string
}

interface AuthenticationPrompts {
  code(): Promise<string>
  password(): Promise<string>
  codeSent(message: string): void
  invalid(kind: "code" | "password"): void
}

export interface ChatSummary {
  readonly id: number
  readonly peer: InputPeerLike
  readonly title: string
  readonly username: string | null
  readonly type: "user" | "group" | "supergroup" | "channel" | "community"
  readonly archived: boolean
  readonly deletionScope: "history" | "own"
}

export interface MessagePreview {
  readonly id: number
  readonly author: string
  readonly own: boolean
  readonly sentAt: Date
  readonly content: string
}

export interface MessagePreviewPage {
  readonly messages: MessagePreview[]
  readonly next?: HistoryOffset
}

interface CountProgress {
  readonly chatId: number
  readonly count: number | null
  readonly analyzed: number
  readonly total: number
  readonly error?: string
}

export interface DeleteProgress {
  readonly chatTitle: string
  readonly deleted: number
  readonly failed: number
  readonly uncertain: number
  readonly processed: number
  readonly expected: number
}

export interface DeleteResult {
  readonly deleted: number
  readonly failed: number
  readonly uncertain: number
  readonly cancelled: boolean
  readonly failures: ReadonlyMap<number, string>
}

interface TelegramApi {
  iterDialogs(): AsyncIterableIterator<Dialog>
  iterSearchMessages(params: {
    chatId: InputPeerLike
    fromUser: "self"
    chunkSize: number
  }): AsyncIterableIterator<Message>
  getHistory(
    chatId: InputPeerLike,
    params: { limit: number; offset?: HistoryOffset },
  ): Promise<ArrayLike<Message> & { total: number; next?: HistoryOffset }>
  resolvePeer(chatId: InputPeerLike): Promise<tl.TypeInputPeer>
  call(request: tl.messages.RawDeleteHistoryRequest): Promise<tl.messages.RawAffectedHistory>
  handleClientUpdate(updates: tl.TypeUpdates): void
  deleteMessagesById(
    chatId: InputPeerLike,
    ids: number[],
    params: { revoke: true },
  ): Promise<void>
  logOut(): Promise<unknown>
  destroy(): Promise<void>
}

const DELETE_BATCH_SIZE = 100
const COUNT_CONCURRENCY = 4
const LOGOUT_TIMEOUT_MS = 3_000
const DESTROY_TIMEOUT_MS = 1_000

export class TelegramService {
  readonly #deletedMessageIds = new Map<number, Set<number>>()

  private constructor(
    private readonly client: TelegramApi,
    private readonly diagnostics: Diagnostics,
    private readonly selfId: number,
  ) {}

  static async authenticate(
    credentials: TelegramCredentials,
    prompts: AuthenticationPrompts,
    diagnostics: Diagnostics,
    abortSignal?: AbortSignal,
  ): Promise<TelegramService> {
    const startedAt = performance.now()
    const client = new TelegramClient({
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      storage: new MemoryStorage(),
      disableUpdates: true,
      logLevel: 0,
      network: {
        middlewares: networkMiddlewares.basic({
          floodWaiter: {
            maxWait: 10_000,
            maxRetries: 3,
            onBeforeWait: (_context, seconds) => {
              diagnostics.record({
                level: "warn",
                operation: "telegram.request",
                outcome: "flood-wait",
                count: seconds,
                code: "FLOOD_WAIT",
              })
            },
          },
        }),
      },
    })

    try {
      const user = await client.start({
        phone: credentials.phone,
        code: prompts.code,
        password: prompts.password,
        codeSentCallback: (code) => {
          if (code.type === "email_required") {
            throw new AuthenticationSetupError(
              "Telegram requires email login setup. Complete it in an official Telegram app, then retry.",
            )
          }
          prompts.codeSent(codeDeliveryMessage(code.type))
        },
        invalidCodeCallback: prompts.invalid,
        ...(abortSignal ? { abortSignal } : {}),
      })
      if (abortSignal?.aborted) {
        throw new DOMException("Authentication cancelled", "AbortError")
      }
      diagnostics.record({
        level: "info",
        operation: "auth.start",
        outcome: "success",
        durationMs: elapsed(startedAt),
      })
      return new TelegramService(client, diagnostics, user.id)
    } catch (error) {
      diagnostics.record({
        level: "error",
        operation: "auth.start",
        outcome: "failed",
        durationMs: elapsed(startedAt),
        code: errorCode(error),
      })
      await closeClient(client, diagnostics)
      throw userFacingError(error)
    }
  }

  async getDialogs(): Promise<ChatSummary[]> {
    const startedAt = performance.now()
    const chats: ChatSummary[] = []
    try {
      for await (const dialog of this.client.iterDialogs()) {
        const peer = dialog.peer
        chats.push({
          id: peer.id,
          peer,
          title: peer.displayName,
          username: peer.username,
          type:
            peer.type === "user"
              ? "user"
              : peer.chatType === "gigagroup" || peer.chatType === "monoforum"
                ? "supergroup"
                : peer.chatType,
          archived: dialog.isArchived,
          deletionScope: peer.type === "user" && peer.id !== this.selfId ? "history" : "own",
        })
      }
      this.diagnostics.record({
        level: "info",
        operation: "dialogs.load",
        outcome: "success",
        durationMs: elapsed(startedAt),
        count: chats.length,
      })
      return chats
    } catch (error) {
      this.recordFailure("dialogs.load", startedAt, error)
      throw userFacingError(error)
    }
  }

  async countCleanupMessages(
    chats: readonly ChatSummary[],
    onProgress: (progress: CountProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let next = 0
    let analyzed = 0
    const worker = async (): Promise<void> => {
      while (!signal?.aborted) {
        const index = next++
        const chat = chats[index]
        if (!chat) return
        const startedAt = performance.now()
        try {
          let count: number
          if (chat.deletionScope === "history") {
            count = (await this.client.getHistory(chat.peer, { limit: 1 })).total
          } else {
            count = 0
            const deletedIds = this.#deletedMessageIds.get(chat.id)
            const staleIds = deletedIds ? new Set<number>() : null
            for await (const message of this.client.iterSearchMessages({
              chatId: chat.peer,
              fromUser: "self",
              chunkSize: DELETE_BATCH_SIZE,
            })) {
              if (signal?.aborted) return
              if (deletedIds?.has(message.id)) {
                staleIds?.add(message.id)
              } else if (isDeletableOwnMessage(message)) {
                count += 1
              }
            }
            if (staleIds?.size) this.#deletedMessageIds.set(chat.id, staleIds)
            else this.#deletedMessageIds.delete(chat.id)
          }
          analyzed += 1
          this.diagnostics.record({
            level: "info",
            operation: "messages.count",
            outcome: "success",
            durationMs: elapsed(startedAt),
            count,
          })
          onProgress({ chatId: chat.id, count, analyzed, total: chats.length })
        } catch (error) {
          analyzed += 1
          if (tl.RpcError.is(error, "CHANNEL_PRIVATE")) {
            onProgress({ chatId: chat.id, count: 0, analyzed, total: chats.length })
            continue
          }
          this.recordFailure("messages.count", startedAt, error)
          onProgress({
            chatId: chat.id,
            count: null,
            analyzed,
            total: chats.length,
            error: userFacingError(error).message,
          })
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(COUNT_CONCURRENCY, chats.length) }, () => worker()),
    )
  }

  async getRecentMessages(
    chat: ChatSummary,
    limit = 15,
    offset?: HistoryOffset,
  ): Promise<MessagePreviewPage> {
    const startedAt = performance.now()
    const preview: MessagePreview[] = []
    try {
      const history = await this.client.getHistory(chat.peer, {
        limit,
        ...(offset ? { offset } : {}),
      })
      for (const message of Array.from(history)) {
        const own = !message.isService && message.sender.id === this.selfId
        preview.push({
          id: message.id,
          author: message.isService ? "Service" : own ? "You" : message.sender.displayName,
          own,
          sentAt: message.date,
          content: previewContent(message),
        })
      }
      preview.reverse()
      this.diagnostics.record({
        level: "info",
        operation: "messages.preview",
        outcome: "success",
        durationMs: elapsed(startedAt),
        count: preview.length,
      })
      return { messages: preview, ...(history.next ? { next: history.next } : {}) }
    } catch (error) {
      this.recordFailure("messages.preview", startedAt, error)
      throw userFacingError(error)
    }
  }

  async deleteSelectedMessages(
    chats: readonly (ChatSummary & { count: number })[],
    onProgress: (progress: DeleteProgress) => void,
    signal: AbortSignal,
  ): Promise<DeleteResult> {
    let deleted = 0
    let failed = 0
    let uncertain = 0
    const failures = new Map<number, string>()
    const expected = chats.reduce((sum, item) => sum + item.count, 0)

    for (const chat of chats) {
      if (signal.aborted) break
      const reportProgress = (): void => {
        onProgress({
          chatTitle: chat.title,
          deleted,
          failed,
          uncertain,
          processed: deleted + failed + uncertain,
          expected,
        })
      }
      if (chat.deletionScope === "history") {
        const result = await this.deletePrivateHistory(chat, signal)
        deleted += result.deleted
        failed += result.failed
        uncertain += result.uncertain
        if (result.error) failures.set(chat.id, result.error)
        if (result.deleted || result.failed || result.uncertain) reportProgress()
        continue
      }

      let batch: number[] = []
      let processedInChat = 0
      let deletedIds = this.#deletedMessageIds.get(chat.id)
      if (!deletedIds) this.#deletedMessageIds.set(chat.id, (deletedIds = new Set()))
      try {
        for await (const message of this.client.iterSearchMessages({
          chatId: chat.peer,
          fromUser: "self",
          chunkSize: DELETE_BATCH_SIZE,
        })) {
          if (signal.aborted) break
          if (!isDeletableOwnMessage(message) || deletedIds?.has(message.id)) continue
          batch.push(message.id)
          if (batch.length !== DELETE_BATCH_SIZE) continue
          const result = await this.deleteBatch(chat, batch)
          deleted += result.deleted
          failed += result.failed
          processedInChat += batch.length
          if (result.error) failures.set(chat.id, result.error)
          batch = []
          reportProgress()
          if (signal.aborted) break
        }
        if (!signal.aborted && batch.length > 0) {
          const result = await this.deleteBatch(chat, batch)
          deleted += result.deleted
          failed += result.failed
          processedInChat += batch.length
          if (result.error) failures.set(chat.id, result.error)
          reportProgress()
        }
      } catch (error) {
        const remaining = Math.max(0, chat.count - processedInChat)
        failed += remaining
        const message = userFacingError(error).message
        failures.set(chat.id, message)
        this.recordFailure("messages.iterate", performance.now(), error, remaining)
        reportProgress()
      }
    }

    return { deleted, failed, uncertain, cancelled: signal.aborted, failures }
  }

  async disconnect(): Promise<void> {
    await closeClient(this.client, this.diagnostics)
  }

  private async deleteBatch(
    chat: ChatSummary,
    ids: number[],
  ): Promise<{ deleted: number; failed: number; error?: string }> {
    const startedAt = performance.now()
    try {
      await this.client.deleteMessagesById(chat.peer, ids, { revoke: true })
      let deletedIds = this.#deletedMessageIds.get(chat.id)
      if (!deletedIds) this.#deletedMessageIds.set(chat.id, (deletedIds = new Set()))
      for (const id of ids) deletedIds.add(id)
      this.diagnostics.record({
        level: "info",
        operation: "messages.delete",
        outcome: "success",
        durationMs: elapsed(startedAt),
        count: ids.length,
      })
      return { deleted: ids.length, failed: 0 }
    } catch (error) {
      this.recordFailure("messages.delete", startedAt, error, ids.length)
      return { deleted: 0, failed: ids.length, error: userFacingError(error).message }
    }
  }

  private async deletePrivateHistory(
    chat: ChatSummary & { count: number },
    signal: AbortSignal,
  ): Promise<{ deleted: number; failed: number; uncertain: number; error?: string }> {
    const startedAt = performance.now()
    let madeProgress = false
    try {
      if (signal.aborted) return { deleted: 0, failed: 0, uncertain: 0 }
      const peer = await this.client.resolvePeer(chat.peer)
      let previousOffset: number | undefined
      while (!signal.aborted) {
        const affected = await this.client.call({
          _: "messages.deleteHistory",
          revoke: true,
          peer,
          maxId: 0,
        })
        madeProgress = true
        this.client.handleClientUpdate({
          _: "updates",
          seq: 0,
          date: 0,
          chats: [],
          users: [],
          updates: [
            {
              _: "mtcute.dummyUpdate",
              channelId: 0,
              pts: affected.pts,
              ptsCount: affected.ptsCount,
            },
          ],
        })
        if (affected.offset === 0) break
        if (previousOffset !== undefined && affected.offset >= previousOffset) {
          throw new Error("Telegram did not advance private history deletion")
        }
        previousOffset = affected.offset
      }
      if (signal.aborted) return { deleted: 0, failed: 0, uncertain: madeProgress ? chat.count : 0 }
      this.diagnostics.record({
        level: "info",
        operation: "history.delete",
        outcome: "success",
        durationMs: elapsed(startedAt),
        count: chat.count,
      })
      return { deleted: chat.count, failed: 0, uncertain: 0 }
    } catch (error) {
      this.recordFailure("history.delete", startedAt, error, chat.count)
      return {
        deleted: 0,
        failed: madeProgress ? 0 : chat.count,
        uncertain: madeProgress ? chat.count : 0,
        error: userFacingError(error).message,
      }
    }
  }

  private recordFailure(operation: string, startedAt: number, error: unknown, count?: number): void {
    this.diagnostics.record({
      level: "error",
      operation,
      outcome: "failed",
      durationMs: elapsed(startedAt),
      ...(count === undefined ? {} : { count }),
      code: errorCode(error),
    })
  }
}

async function closeClient(
  client: TelegramApi,
  diagnostics: Diagnostics,
): Promise<void> {
  const logoutStartedAt = performance.now()
  try {
    await withTimeout(client.logOut(), LOGOUT_TIMEOUT_MS)
    diagnostics.record({
      level: "info",
      operation: "auth.logout",
      outcome: "success",
      durationMs: elapsed(logoutStartedAt),
    })
  } catch (error) {
    diagnostics.record({
      level: "warn",
      operation: "auth.logout",
      outcome: "failed",
      durationMs: elapsed(logoutStartedAt),
      code: errorCode(error),
    })
  }

  const destroyStartedAt = performance.now()
  try {
    await withTimeout(client.destroy(), DESTROY_TIMEOUT_MS)
    diagnostics.record({
      level: "info",
      operation: "client.destroy",
      outcome: "success",
      durationMs: elapsed(destroyStartedAt),
    })
  } catch (error) {
    diagnostics.record({
      level: "warn",
      operation: "client.destroy",
      outcome: "failed",
      durationMs: elapsed(destroyStartedAt),
      code: errorCode(error),
    })
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("Telegram shutdown timed out")
      error.name = "TimeoutError"
      reject(error)
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function previewContent(message: Message): string {
  const text = message.text.trim().replace(/\s+/g, " ")
  if (text) return text
  const type = message.media?.type
  if (!type) return message.isService ? "[Service message]" : "[Message]"
  const labels: Partial<Record<typeof type, string>> = {
    photo: "Photo",
    video: "Video",
    voice: "Voice message",
    audio: "Audio",
    document: "Document",
    sticker: "Sticker",
    poll: "Poll",
    contact: "Contact",
    location: "Location",
  }
  return `[${labels[type] ?? "Media"}]`
}

function isDeletableOwnMessage(message: Message): boolean {
  return !message.isService
}

class AuthenticationSetupError extends Error {}

function codeDeliveryMessage(type: string): string {
  switch (type) {
    case "app":
      return "Enter the code sent to another logged-in Telegram app"
    case "sms":
    case "sms_word":
    case "sms_phrase":
    case "firebase":
      return "Enter the code sent by SMS"
    case "call":
      return "Enter the code provided by Telegram's phone call"
    case "flash_call":
    case "missed_call":
      return "Enter the code from Telegram's phone call"
    case "email":
      return "Enter the code sent to your Telegram login email"
    case "fragment":
      return "Open Fragment to view and enter the Telegram login code"
    default:
      return "Enter the login code Telegram sent"
  }
}

function errorCode(error: unknown): string {
  if (tl.RpcError.is(error)) return error.text
  if (error instanceof Error) return error.name
  return "UNKNOWN"
}

function userFacingError(error: unknown): Error {
  if (error instanceof AuthenticationSetupError) return error
  if (tl.RpcError.is(error, "API_ID_INVALID")) return new Error("Invalid API credentials")
  if (tl.RpcError.is(error, "PHONE_CODE_INVALID")) return new Error("Incorrect login code")
  if (tl.RpcError.is(error, "PHONE_CODE_EXPIRED")) return new Error("Login code expired")
  if (tl.RpcError.is(error, "PASSWORD_HASH_INVALID")) return new Error("Incorrect two-factor password")
  if (tl.RpcError.is(error, "FLOOD_WAIT_%d")) {
    return new Error(`Telegram requested a ${error.seconds}-second wait`)
  }
  if (tl.RpcError.is(error, "CHANNEL_PRIVATE")) return new Error("Unable to access this chat")
  if (tl.RpcError.is(error)) return new Error(`Telegram error: ${error.text}`)
  return new Error("Connection to Telegram failed")
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}
