import { Boom } from '@hapi/boom'
import makeWASocket from '../Socket'
import type { AnyMessageContent, MiscMessageGenerationOptions, UserFacingSocketConfig, WAMessage, ParticipantAction, GroupParticipant, WAMessageKey, PresenceData, MessageUserReceiptUpdate } from '../Types'
import { DisconnectReason } from '../Types'
import type { ILogger } from '../Utils/logger'
import { isJidGroup } from '../WABinary'
import { getAggregateVotesInPollMessage } from '../Utils'
import { SQLiteStore } from './Store/SQLiteStore'
import { Context } from './Context'
import { SessionManager } from './SessionManager'
import { StatsManager } from './StatsManager'

export type WASocket = ReturnType<typeof makeWASocket>
export type MiddlewareFn = (ctx: Context, next: () => Promise<void>) => Promise<void> | void

export interface PollVoteContext {
	sender: string
	pollId: string
	pollName: string
	selectedOptions: string[]
}

export interface GroupParticipantsUpdateEvent {
	id: string
	participants: string[]
	action: ParticipantAction
}

export interface PresenceUpdateEvent {
	id: string
	presences: { [participant: string]: PresenceData }
}

export type BotConfig = UserFacingSocketConfig & {
	enableStats?: boolean
	rateLimitMs?: number
	autoReadMs?: number
	dbPath?: string
	/** Maximum messages to hold in memory while disconnected (default: 1000) */
	maxQueueSize?: number
}

type EnqueuedMessage = {
	jid: string
	content: AnyMessageContent
	options: MiscMessageGenerationOptions
	resolve: (value: unknown) => void
	reject: (reason?: unknown) => void
}

export class Bot {
	public socket: WASocket | undefined
	private middlewares: MiddlewareFn[] = []
	private config: BotConfig
	public logger: ILogger

	// Database and Managers
	public readonly store: SQLiteStore
	public readonly session: SessionManager
	public readonly stats?: StatsManager

	// Connection state
	public isConnected = false
	public state: 'DISCONNECTED' | 'QR_READY' | 'CONNECTED' = 'DISCONNECTED'
	private reconnectAttempts = 0
	private reconnectTimer: NodeJS.Timeout | null = null
	private readonly MAX_RECONNECT_DELAY = 60000
	private readonly BASE_RECONNECT_DELAY = 2000

	// Message Queue
	private messageQueue: EnqueuedMessage[] = []
	private sendQueue: EnqueuedMessage[] = []
	private isProcessingSendQueue = false

	// Event listeners registered via onConnection/onCreds/onQR/onStateChange
	private connectionHandlers: Array<(update: { connection?: string; lastDisconnect?: { error?: Error } }) => void> = []
	private credsHandlers: Array<() => void> = []
	private qrHandlers: Array<(qr: string) => void> = []
	private stateHandlers: Array<(state: 'DISCONNECTED' | 'QR_READY' | 'CONNECTED') => void> = []
	private pollVoteHandlers: Array<(vote: PollVoteContext) => void> = []
	private groupParticipantsHandlers: Array<(event: GroupParticipantsUpdateEvent) => void> = []
	private presenceUpdateHandlers: Array<(event: PresenceUpdateEvent) => void> = []
	private messageReceiptHandlers: Array<(update: MessageUserReceiptUpdate) => void> = []

	constructor(config: BotConfig) {
		this.store = new SQLiteStore(config.dbPath)
		this.session = new SessionManager(this.store)

		// Use Baileys' logger if provided, otherwise create a minimal one
		this.logger = (config.logger ?? console) as ILogger

		if (config.enableStats !== false) {
			this.stats = new StatsManager(this, this.store)
		}

		this.config = {
			...config,
			msgRetryCounterCache: this.store
		}
	}

	public use(middleware: MiddlewareFn) {
		this.middlewares.push(middleware)
	}

	public command(cmd: string, handler: (ctx: Context) => Promise<void> | void) {
		this.use(async (ctx, next) => {
			if (ctx.text?.startsWith(cmd)) {
				await handler(ctx)
			}

			await next()
		})
	}

	public onText(handler: (ctx: Context) => Promise<void> | void) {
		this.use(async (ctx, next) => {
			if (ctx.text) {
				await handler(ctx)
			}

			await next()
		})
	}

	public onPollVote(handler: (vote: PollVoteContext) => void) {
		this.pollVoteHandlers.push(handler)
	}

	public onGroupParticipantsUpdate(handler: (event: GroupParticipantsUpdateEvent) => void) {
		this.groupParticipantsHandlers.push(handler)
	}

	public onPresenceUpdate(handler: (event: PresenceUpdateEvent) => void) {
		this.presenceUpdateHandlers.push(handler)
	}

	public onMessageReceiptUpdate(handler: (update: MessageUserReceiptUpdate) => void) {
		this.messageReceiptHandlers.push(handler)
	}

	/**
	 * Mark messages as read. Useful for triggering from a Web Dashboard.
	 */
	public async readMessages(keys: WAMessageKey[]) {
		if (!this.isConnected || !this.socket) {
			throw new Error('Cannot read messages while disconnected')
		}
		return this.socket.readMessages(keys)
	}

	/**
	 * Register a handler for connection updates. These handlers are
	 * guaranteed to fire even though they are registered before start().
	 */
	public onConnection(handler: (update: { connection?: string; lastDisconnect?: { error?: Error } }) => void) {
		this.connectionHandlers.push(handler)
	}

	/**
	 * Register a handler to persist credentials. Guaranteed to fire
	 * even though it is registered before start().
	 */
	public onCreds(handler: () => void) {
		this.credsHandlers.push(handler)
	}

	/**
	 * Register a handler for when a new QR code is generated.
	 * This makes it easy to forward the QR string to a frontend API.
	 */
	public onQR(handler: (qr: string) => void) {
		this.qrHandlers.push(handler)
	}

	/**
	 * Register a handler for high-level state changes.
	 * Useful for web dashboards to know if the bot is ready.
	 */
	public onStateChange(handler: (state: 'DISCONNECTED' | 'QR_READY' | 'CONNECTED') => void) {
		this.stateHandlers.push(handler)
	}

	private updateState(newState: 'DISCONNECTED' | 'QR_READY' | 'CONNECTED') {
		if (this.state !== newState) {
			this.state = newState
			for (const handler of this.stateHandlers) {
				try {
					handler(newState)
				} catch (err) {
					this.logger.error?.({ err }, 'state handler threw')
				}
			}
		}
	}

	public async sendMessage(
		jid: string,
		content: AnyMessageContent,
		options: MiscMessageGenerationOptions & { ignoreRateLimit?: boolean } = {}
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const msg: EnqueuedMessage = { jid, content, options, resolve, reject }
			if (this.isConnected && this.socket) {
				// Bypass the queue if ignoreRateLimit is explicitly set
				if (options.ignoreRateLimit) {
					this.socket.sendMessage(jid, content, options).then(resolve).catch(reject)
				} else if (this.config.rateLimitMs && this.config.rateLimitMs > 0) {
					this.sendQueue.push(msg)
					this.processSendQueue()
				} else {
					this.socket.sendMessage(jid, content, options).then(resolve).catch(reject)
				}
			} else {
				if (this.messageQueue.length < (this.config.maxQueueSize ?? 1000)) {
					this.messageQueue.push(msg)
					this.logger.debug?.({ jid, queueLength: this.messageQueue.length }, 'message queued while disconnected')
				} else {
					reject(new Error('Message queue full — bot is disconnected and queue limit reached'))
				}
			}
		})
	}

	private async processSendQueue() {
		if (this.isProcessingSendQueue || this.sendQueue.length === 0 || !this.isConnected || !this.socket) return

		this.isProcessingSendQueue = true

		while (this.sendQueue.length > 0 && this.isConnected && this.socket) {
			const msg = this.sendQueue.shift()
			if (msg) {
				try {
					const result = await this.socket.sendMessage(msg.jid, msg.content, msg.options)
					msg.resolve(result)
				} catch (err) {
					msg.reject(err)
				}

				if (this.sendQueue.length > 0 && this.config.rateLimitMs) {
					await new Promise(resolve => setTimeout(resolve, this.config.rateLimitMs))
				}
			}
		}

		this.isProcessingSendQueue = false
	}

	private drainQueue() {
		if (!this.isConnected || !this.socket || this.messageQueue.length === 0) return

		this.logger.info({ pending: this.messageQueue.length }, 'draining reconnection queue')
		const queueToProcess = [...this.messageQueue]
		this.messageQueue = []

		for (const msg of queueToProcess) {
			if (this.config.rateLimitMs && this.config.rateLimitMs > 0) {
				this.sendQueue.push(msg)
			} else {
				this.socket.sendMessage(msg.jid, msg.content, msg.options).then(msg.resolve).catch(msg.reject)
			}
		}

		if (this.config.rateLimitMs && this.config.rateLimitMs > 0) {
			this.processSendQueue()
		}
	}

	public async start() {
		// Clean up old socket listeners to prevent duplicate registrations on reconnect
		if (this.socket) {
			this.socket.ev.removeAllListeners('connection.update')
			this.socket.ev.removeAllListeners('messages.upsert')
			this.socket.ev.removeAllListeners('creds.update')
			this.socket.ev.removeAllListeners('messages.update')
			this.socket.ev.removeAllListeners('group-participants.update')
			this.socket.ev.removeAllListeners('presence.update')
			this.socket.ev.removeAllListeners('message-receipt.update')
		}

		this.socket = makeWASocket(this.config)

		this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
			if (type !== 'notify') return
			for (const msg of messages) {
				// Save poll creation messages so we can decode votes later
				if (msg.message?.pollCreationMessage || msg.message?.pollCreationMessageV2 || msg.message?.pollCreationMessageV3) {
					if (msg.key.id) {
						this.store.set(`msg_poll_${msg.key.id}`, msg)
					}
				}

				// Skip messages sent by the bot itself for standard handlers
				if (msg.key.fromMe) continue

				const ctx = new Context(this, msg)

				// Smart Read
				if (this.config.autoReadMs !== undefined && this.config.autoReadMs >= 0) {
					ctx.read(this.config.autoReadMs).catch(err => {
						this.logger.error?.({ err }, 'auto-read failed')
					})
				}

				// Analytics: observe the message before middlewares
				if (this.stats && ctx.remoteJid && isJidGroup(ctx.remoteJid)) {
					const participant = msg.key.participant || msg.participant
					if (participant) {
						const isSticker = !!msg.message?.stickerMessage
						this.stats.observeMessage(ctx.remoteJid, participant, isSticker)
					}
				}

				try {
					await this.executeMiddlewares(ctx)
				} catch (err) {
					this.logger.error?.({ err }, 'middleware execution failed')
				}
			}
		})

		this.socket.ev.on('messages.update', async (updates) => {
			for (const update of updates) {
				if (update.update.pollUpdates && update.update.pollUpdates.length > 0 && update.key.id) {
					const msg = this.store.get<WAMessage>(`msg_poll_${update.key.id}`)
					if (msg) {
						// Merge the update into the original message for aggregation
						msg.pollUpdates = update.update.pollUpdates
						const pollData = getAggregateVotesInPollMessage(msg)
						
						for (const pollUpdate of update.update.pollUpdates) {
							if (!pollUpdate.pollUpdateMessageKey?.participant) continue
							
							const voter = pollUpdate.pollUpdateMessageKey.participant
							const selectedOptions = pollData.filter((v: any) => v.voters.includes(voter)).map((v: any) => v.name)
							
							const context: PollVoteContext = {
								sender: voter,
								pollId: update.key.id,
								pollName: msg.message?.pollCreationMessage?.name || msg.message?.pollCreationMessageV2?.name || msg.message?.pollCreationMessageV3?.name || '',
								selectedOptions
							}
							
							for (const handler of this.pollVoteHandlers) {
								try {
									handler(context)
								} catch (err) {
									this.logger.error?.({ err }, 'poll vote handler threw')
								}
							}
						}
					}
				}
			}
		})

		this.socket.ev.on('group-participants.update', async (update) => {
			for (const handler of this.groupParticipantsHandlers) {
				try {
					handler({
						id: update.id,
						participants: (update.participants as any[]).map(p => typeof p === 'string' ? p : p.id),
						action: update.action
					})
				} catch (err) {
					this.logger.error?.({ err }, 'group-participants handler threw')
				}
			}
		})

		this.socket.ev.on('presence.update', async (update) => {
			for (const handler of this.presenceUpdateHandlers) {
				try {
					handler(update)
				} catch (err) {
					this.logger.error?.({ err }, 'presence.update handler threw')
				}
			}
		})

		this.socket.ev.on('message-receipt.update', async (updates) => {
			for (const update of updates) {
				for (const handler of this.messageReceiptHandlers) {
					try {
						handler(update)
					} catch (err) {
						this.logger.error?.({ err }, 'message-receipt handler threw')
					}
				}
			}
		})

		this.socket.ev.on('connection.update', update => {
			const { connection, lastDisconnect, qr } = update

			if (qr) {
				this.updateState('QR_READY')
				for (const handler of this.qrHandlers) {
					try {
						handler(qr)
					} catch (err) {
						this.logger.error?.({ err }, 'qr handler threw')
					}
				}
			}

			if (connection === 'open') {
				this.logger.info('connection established')
				this.isConnected = true
				this.updateState('CONNECTED')
				this.reconnectAttempts = 0
				this.drainQueue()
			}

			if (connection === 'close') {
				this.isConnected = false
				this.updateState('DISCONNECTED')
				const error = lastDisconnect?.error as Boom | undefined
				const statusCode = error?.output?.statusCode
				const shouldReconnect = statusCode !== DisconnectReason.loggedOut

				this.logger.warn({ statusCode }, 'connection closed')

				if (shouldReconnect) {
					// 440 = connection replaced (another tab opened)
					// 500 = bad session
					// Prevent aggressive reconnect loops on these fatal codes
					if (statusCode === DisconnectReason.connectionReplaced || statusCode === DisconnectReason.badSession) {
						this.logger.warn({ statusCode }, 'Session conflict or corrupted. Delaying reconnect to avoid ban loop.')
						this.reconnectAttempts = Math.max(this.reconnectAttempts, 5) // force longer delay
					}

					// If the QR code timed out (408), restart immediately without exponential backoff
					// to keep the QR alive infinitely.
					if (statusCode === DisconnectReason.timedOut) {
						this.logger.info('QR Code timed out. Restarting connection immediately.')
						this.reconnectAttempts = 0
					} else {
						this.reconnectAttempts++
					}

					const delay =
						statusCode === DisconnectReason.timedOut
							? 1000
							: Math.min(this.MAX_RECONNECT_DELAY, this.BASE_RECONNECT_DELAY * 2 ** (this.reconnectAttempts - 1))

					this.logger.info({ delay, attempt: this.reconnectAttempts }, 'scheduling reconnect')

					if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
					this.reconnectTimer = setTimeout(() => {
						this.start()
					}, delay)
				} else {
					this.logger.warn('session logged out, will not reconnect automatically')
				}
			}

			// Fire user-registered connection handlers
			for (const handler of this.connectionHandlers) {
				try {
					handler(update)
				} catch (err) {
					this.logger.error?.({ err }, 'connection handler threw')
				}
			}
		})

		this.socket.ev.on('creds.update', () => {
			for (const handler of this.credsHandlers) {
				try {
					handler()
				} catch (err) {
					this.logger.error?.({ err }, 'creds handler threw')
				}
			}
		})
	}

	/**
	 * Graceful shutdown: close database and clear queues.
	 * Also removes all event listeners and clears timers to allow Garbage Collection.
	 */
	public close() {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null

		this.socket?.ev.removeAllListeners('connection.update')
		this.socket?.ev.removeAllListeners('messages.upsert')
		this.socket?.ev.removeAllListeners('creds.update')
		this.socket?.ev.removeAllListeners('messages.update')
		this.socket?.ev.removeAllListeners('group-participants.update')
		this.socket?.ev.removeAllListeners('presence.update')
		this.socket?.ev.removeAllListeners('message-receipt.update')
		this.socket = undefined

		this.messageQueue = []
		this.sendQueue = []
		this.isProcessingSendQueue = false

		this.connectionHandlers = []
		this.credsHandlers = []
		this.qrHandlers = []
		this.stateHandlers = []
		this.pollVoteHandlers = []
		this.groupParticipantsHandlers = []
		this.presenceUpdateHandlers = []
		this.messageReceiptHandlers = []
		this.middlewares = []

		this.stats?.stop()
		this.store.close()
	}

	/**
	 * Permanently logs out the current session from WhatsApp,
	 * terminates the socket, and destroys the local SQLite database to prevent leaks.
	 */
	public async logout() {
		this.logger.info('Logging out and destroying session...')
		try {
			await this.socket?.logout()
		} catch (err) {
			this.logger.error({ err }, 'Error during socket logout')
		}

		this.socket?.end(undefined)
		this.close()
	}

	private async executeMiddlewares(ctx: Context) {
		let index = -1
		const dispatch = async (i: number): Promise<void> => {
			if (i <= index) throw new Error('next() called multiple times')
			index = i
			const middleware = this.middlewares[i]
			if (middleware) {
				await middleware(ctx, () => dispatch(i + 1))
			}
		}

		await dispatch(0)
	}
}
