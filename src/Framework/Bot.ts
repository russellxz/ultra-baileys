import { Boom } from '@hapi/boom'
import makeWASocket from '../Socket'
import { DisconnectReason } from '../Types'
import { isJidGroup } from '../WABinary'
import type { UserFacingSocketConfig, AnyMessageContent, MiscMessageGenerationOptions } from '../Types'
import type { ILogger } from '../Utils/logger'
import { Context } from './Context'
import { SQLiteStore } from './Store/SQLiteStore'
import { SessionManager } from './SessionManager'
import { StatsManager } from './StatsManager'

export type WASocket = ReturnType<typeof makeWASocket>
export type MiddlewareFn = (ctx: Context, next: () => Promise<void>) => Promise<void> | void

export type BotConfig = UserFacingSocketConfig & {
	enableStats?: boolean
	rateLimitMs?: number
	autoReadMs?: number
	dbPath?: string
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
	public isConnected: boolean = false
	private reconnectAttempts: number = 0
	private readonly MAX_RECONNECT_DELAY = 60000
	private readonly BASE_RECONNECT_DELAY = 2000

	// Message Queue
	private messageQueue: EnqueuedMessage[] = []
	private sendQueue: EnqueuedMessage[] = []
	private isProcessingSendQueue: boolean = false

	// Event listeners registered via onConnection/onCreds/onQR
	private connectionHandlers: Array<(update: { connection?: string, lastDisconnect?: { error?: Error } }) => void> = []
	private credsHandlers: Array<() => void> = []
	private qrHandlers: Array<(qr: string) => void> = []

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

	/**
	 * Register a handler for connection updates. These handlers are
	 * guaranteed to fire even though they are registered before start().
	 */
	public onConnection(handler: (update: { connection?: string, lastDisconnect?: { error?: Error } }) => void) {
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
				this.messageQueue.push(msg)
				this.logger.debug?.({ jid, queueLength: this.messageQueue.length }, 'message queued while disconnected')
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
				this.socket.sendMessage(msg.jid, msg.content, msg.options)
					.then(msg.resolve)
					.catch(msg.reject)
			}
		}

		if (this.config.rateLimitMs && this.config.rateLimitMs > 0) {
			this.processSendQueue()
		}
	}

	public async start() {
		this.socket = makeWASocket(this.config)

		this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
			if (type !== 'notify') return
			for (const msg of messages) {
				// Skip messages sent by the bot itself
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

		this.socket.ev.on('connection.update', (update) => {
			const { connection, lastDisconnect, qr } = update

			if (qr) {
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
				this.reconnectAttempts = 0
				this.drainQueue()
			}

			if (connection === 'close') {
				this.isConnected = false
				const error = lastDisconnect?.error as Boom | undefined
				const statusCode = error?.output?.statusCode
				const shouldReconnect = statusCode !== DisconnectReason.loggedOut

				this.logger.warn({ statusCode }, 'connection closed')

				if (shouldReconnect) {
					// If the QR code timed out (408), restart immediately without exponential backoff
					// to keep the QR alive infinitely.
					if (statusCode === DisconnectReason.timedOut) {
						this.logger.info('QR Code timed out. Restarting connection immediately.')
						this.reconnectAttempts = 0
					} else {
						this.reconnectAttempts++
					}
					
					const delay = statusCode === DisconnectReason.timedOut 
						? 1000 
						: Math.min(this.MAX_RECONNECT_DELAY, this.BASE_RECONNECT_DELAY * (2 ** (this.reconnectAttempts - 1)))
					
					this.logger.info({ delay, attempt: this.reconnectAttempts }, 'scheduling reconnect')

					setTimeout(() => {
						this.start()
					}, delay)
				} else {
					this.logger.warn('session logged out, will not reconnect automatically')
				}
			}

			// Fire user-registered connection handlers
			for (const handler of this.connectionHandlers) {
				try {
					handler(update as { connection?: string, lastDisconnect?: { error?: Error } })
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
	 */
	public close() {
		this.messageQueue = []
		this.sendQueue = []
		this.isProcessingSendQueue = false
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
