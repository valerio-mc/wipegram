import {
  MemoryStorage,
  TelegramClient,
  networkMiddlewares,
  tl,
  type Dialog,
  type InputPeerLike,
  type Message,
  type User,
} from "@mtcute/bun"
import type { Diagnostics } from "./diagnostics"

export interface TelegramCredentials {
  apiId: number
  apiHash: string
  phone: string
}

export interface AuthenticationPrompts {
  code(): Promise<string>
  password(): Promise<string>
  invalid(kind: "code" | "password"): void
  codeSent(): void
}

export interface ChatSummary {
  readonly id: number
  readonly peer: InputPeerLike
  readonly title: string
  readonly username: string | null
  readonly type: "user" | "group" | "supergroup" | "channel" | "community"
  readonly archived: boolean
  readonly muted: boolean
  readonly lastActivity: Date | null
}

export interface MessagePreview {
  readonly id: number
  readonly author: string
  readonly own: boolean
  readonly sentAt: Date
  readonly content: string
}

export interface CountProgress {
  readonly chatId: number
  readonly count: number | null
  readonly analyzed: number
  readonly total: number
  readonly error?: string
}

export interface DeleteProgress {
  readonly chatId: number
  readonly chatTitle: string
  readonly deleted: number
  readonly failed: number
  readonly processed: number
  readonly expected: number
}

export interface DeleteResult {
  readonly deleted: number
  readonly failed: number
  readonly cancelled: boolean
  readonly failures: ReadonlyMap<number, string>
}

interface TelegramApi {
  iterDialogs(): AsyncIterableIterator<Dialog>
  searchMessages(params: {
    chatId: InputPeerLike
    fromUser: "self"
    limit: number
  }): Promise<ArrayLike<Message> & { total: number }>
  iterSearchMessages(params: {
    chatId: InputPeerLike
    fromUser: "self"
    chunkSize: number
  }): AsyncIterableIterator<Message>
  iterHistory(chatId: InputPeerLike, params: { limit: number }): AsyncIterableIterator<Message>
  deleteMessagesById(
    chatId: InputPeerLike,
    ids: number[],
    params: { revoke: true },
  ): Promise<void>
  destroy(): Promise<void>
}

const DELETE_BATCH_SIZE = 100
const COUNT_CONCURRENCY = 4

export class TelegramService {
  private constructor(
    private readonly client: TelegramApi,
    private readonly diagnostics: Diagnostics,
    private readonly selfId: number | null,
  ) {}

  static async authenticate(
    credentials: TelegramCredentials,
    prompts: AuthenticationPrompts,
    diagnostics: Diagnostics,
  ): Promise<{ service: TelegramService; user: User }> {
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
        codeSentCallback: prompts.codeSent,
        invalidCodeCallback: prompts.invalid,
      })
      diagnostics.record({
        level: "info",
        operation: "auth.start",
        outcome: "success",
        durationMs: elapsed(startedAt),
      })
      return { service: new TelegramService(client, diagnostics, user.id), user }
    } catch (error) {
      diagnostics.record({
        level: "error",
        operation: "auth.start",
        outcome: "failed",
        durationMs: elapsed(startedAt),
        code: errorCode(error),
      })
      await client.destroy()
      throw userFacingError(error)
    }
  }

  static fromApi(api: TelegramApi, diagnostics: Diagnostics, selfId: number | null = null): TelegramService {
    return new TelegramService(api, diagnostics, selfId)
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
          muted: dialog.isMuted === true,
          lastActivity: dialog.lastMessage?.date ?? null,
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

  async countOwnMessages(
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
          const messages = await this.client.searchMessages({
            chatId: chat.peer,
            fromUser: "self",
            limit: 1,
          })
          analyzed += 1
          this.diagnostics.record({
            level: "info",
            operation: "messages.count",
            outcome: "success",
            durationMs: elapsed(startedAt),
            count: messages.total,
          })
          onProgress({ chatId: chat.id, count: messages.total, analyzed, total: chats.length })
        } catch (error) {
          analyzed += 1
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

  async getRecentMessages(chat: ChatSummary, limit = 8): Promise<MessagePreview[]> {
    const startedAt = performance.now()
    const preview: MessagePreview[] = []
    try {
      for await (const message of this.client.iterHistory(chat.peer, { limit })) {
        const own = message.isOutgoing || message.sender.id === this.selfId
        preview.push({
          id: message.id,
          author: own ? "You" : message.sender.displayName,
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
      return preview
    } catch (error) {
      this.recordFailure("messages.preview", startedAt, error)
      throw userFacingError(error)
    }
  }

  async deleteOwnMessages(
    chats: readonly (ChatSummary & { count: number })[],
    onProgress: (progress: DeleteProgress) => void,
    signal: AbortSignal,
  ): Promise<DeleteResult> {
    let deleted = 0
    let failed = 0
    const failures = new Map<number, string>()

    for (const chat of chats) {
      if (signal.aborted) break
      let batch: number[] = []
      for await (const message of this.client.iterSearchMessages({
        chatId: chat.peer,
        fromUser: "self",
        chunkSize: DELETE_BATCH_SIZE,
      })) {
        if (signal.aborted) break
        batch.push(message.id)
        if (batch.length === DELETE_BATCH_SIZE) {
          const result = await this.deleteBatch(chat, batch)
          deleted += result.deleted
          failed += result.failed
          if (result.error) failures.set(chat.id, result.error)
          batch = []
          onProgress({
            chatId: chat.id,
            chatTitle: chat.title,
            deleted,
            failed,
            processed: deleted + failed,
            expected: chats.reduce((sum, item) => sum + item.count, 0),
          })
        }
      }
      if (!signal.aborted && batch.length > 0) {
        const result = await this.deleteBatch(chat, batch)
        deleted += result.deleted
        failed += result.failed
        if (result.error) failures.set(chat.id, result.error)
        onProgress({
          chatId: chat.id,
          chatTitle: chat.title,
          deleted,
          failed,
          processed: deleted + failed,
          expected: chats.reduce((sum, item) => sum + item.count, 0),
        })
      }
    }

    return { deleted, failed, cancelled: signal.aborted, failures }
  }

  async disconnect(): Promise<void> {
    const startedAt = performance.now()
    await this.client.destroy()
    this.diagnostics.record({
      level: "info",
      operation: "client.destroy",
      outcome: "success",
      durationMs: elapsed(startedAt),
    })
  }

  private async deleteBatch(
    chat: ChatSummary,
    ids: number[],
  ): Promise<{ deleted: number; failed: number; error?: string }> {
    const startedAt = performance.now()
    try {
      await this.client.deleteMessagesById(chat.peer, ids, { revoke: true })
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

function errorCode(error: unknown): string {
  if (tl.RpcError.is(error)) return error.text
  if (error instanceof Error) return error.name
  return "UNKNOWN"
}

export function userFacingError(error: unknown): Error {
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
