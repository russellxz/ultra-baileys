import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from '../Types'
import type { Bot, WASocket } from './Bot'
import { MediaManager, type StickerMetadata } from './MediaManager'
import { downloadMediaMessage } from '../Utils'

export class Context {
	public readonly message: WAMessage
	public readonly bot: Bot
	public readonly remoteJid: string

	/** Extracted text from conversation or extendedTextMessage */
	public get text(): string | undefined {
		return this.message.message?.conversation || this.message.message?.extendedTextMessage?.text || undefined
	}

	/** The sender JID — works for both groups and private chats */
	public get sender(): string {
		return this.message.key.participant || this.message.key.remoteJid || ''
	}

	/** Whether this message was sent inside a group chat */
	public get isGroup(): boolean {
		return this.remoteJid.endsWith('@g.us')
	}

	/** Shortcut to session data for this chat */
	public readonly session: {
		get: <T = unknown>() => T | undefined
		set: <T = unknown>(data: T) => void
		update: <T = unknown>(data: Partial<T>) => void
		delete: () => void
	}

	/** Whether the incoming message contains an image */
	public get hasImage(): boolean {
		return !!this.message.message?.imageMessage
	}

	/** Whether the incoming message contains a video */
	public get hasVideo(): boolean {
		return !!this.message.message?.videoMessage
	}

	/** Whether the incoming message contains a sticker */
	public get hasSticker(): boolean {
		return !!this.message.message?.stickerMessage
	}

	/** Whether the incoming message contains audio */
	public get hasAudio(): boolean {
		return !!this.message.message?.audioMessage
	}

	/** The caption text from image/video messages */
	public get caption(): string | undefined {
		return this.message.message?.imageMessage?.caption || this.message.message?.videoMessage?.caption || undefined
	}

	constructor(bot: Bot, message: WAMessage) {
		this.bot = bot
		this.message = message
		this.remoteJid = message.key.remoteJid || ''

		// Cache the session accessor so we don't create a new object per access
		this.session = {
			get: <T = unknown>() => this.bot.session.get<T>(this.remoteJid),
			set: <T = unknown>(data: T) => this.bot.session.set(this.remoteJid, data),
			update: <T = unknown>(data: Partial<T>) => this.bot.session.update(this.remoteJid, data),
			delete: () => this.bot.session.delete(this.remoteJid)
		}
	}

	/** Reply to the current message (auto-quotes) */
	public async reply(content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) {
		if (!this.remoteJid) {
			throw new Error('remoteJid is undefined')
		}

		return this.bot.sendMessage(this.remoteJid, content, { quoted: this.message, ...options })
	}

	/** Send a message to the same chat without quoting */
	public async send(content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) {
		if (!this.remoteJid) {
			throw new Error('remoteJid is undefined')
		}

		return this.bot.sendMessage(this.remoteJid, content, options)
	}

	/** React to the current message with an emoji */
	public async react(emoji: string) {
		if (!this.remoteJid || !this.message.key) {
			throw new Error('Cannot react without remoteJid or message key')
		}

		return this.bot.sendMessage(this.remoteJid, {
			react: { text: emoji, key: this.message.key }
		})
	}

	/** Convert media to WebP sticker and send it as a reply */
	public async replySticker(media: Buffer | string, metadata?: StickerMetadata) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')

		const webpBuffer = await MediaManager.convertToSticker(media, metadata)
		return this.bot.sendMessage(this.remoteJid, { sticker: webpBuffer }, { quoted: this.message })
	}

	/** Convert audio to Opus/OGG and send it as a voice note */
	public async replyVoiceNote(media: Buffer | string) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')

		const oggBuffer = await MediaManager.convertToVoiceNote(media)
		return this.bot.sendMessage(
			this.remoteJid,
			{
				audio: oggBuffer,
				mimetype: 'audio/ogg; codecs=opus',
				ptt: true
			},
			{ quoted: this.message }
		)
	}

	/** Mark this message as read, with an optional delay */
	public async read(delayMs?: number) {
		if (!this.bot.socket || !this.message.key) return

		if (delayMs && delayMs > 0) {
			await new Promise(resolve => setTimeout(resolve, delayMs))
		}

		return this.bot.socket.readMessages([this.message.key])
	}

	/** Send a poll to the current chat */
	public async sendPoll(name: string, values: string[], selectableCount = 1) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')

		return this.bot.sendMessage(this.remoteJid, {
			poll: {
				name,
				values,
				selectableCount
			}
		})
	}

	/** Reply with a poll to the current message */
	public async replyPoll(name: string, values: string[], selectableCount = 1) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')

		return this.bot.sendMessage(
			this.remoteJid,
			{
				poll: {
					name,
					values,
					selectableCount
				}
			},
			{ quoted: this.message }
		)
	}

	/** Send a location to the current chat */
	public async sendLocation(degreesLatitude: number, degreesLongitude: number, name?: string, address?: string) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')

		return this.bot.sendMessage(this.remoteJid, {
			location: {
				degreesLatitude,
				degreesLongitude,
				name,
				address
			}
		})
	}

	/** Reply with a location to the current message */
	public async replyLocation(degreesLatitude: number, degreesLongitude: number, name?: string, address?: string) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')

		return this.bot.sendMessage(
			this.remoteJid,
			{
				location: {
					degreesLatitude,
					degreesLongitude,
					name,
					address
				}
			},
			{ quoted: this.message }
		)
	}

	/** Send an image to the current chat */
	public async sendImage(urlOrBuffer: Buffer | { url: string }, caption?: string) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')
		return this.bot.sendMessage(this.remoteJid, { image: urlOrBuffer, caption })
	}

	/** Send a video to the current chat */
	public async sendVideo(urlOrBuffer: Buffer | { url: string }, caption?: string, gifPlayback = false) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')
		return this.bot.sendMessage(this.remoteJid, { video: urlOrBuffer, caption, gifPlayback })
	}

	/** Send an audio message (PTT or standard) */
	public async sendAudio(urlOrBuffer: Buffer | { url: string }, ptt = false) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')
		return this.bot.sendMessage(this.remoteJid, { audio: urlOrBuffer, ptt })
	}

	/** Send a document file */
	public async sendDocument(urlOrBuffer: Buffer | { url: string }, mimetype: string, fileName?: string, caption?: string) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')
		return this.bot.sendMessage(this.remoteJid, { document: urlOrBuffer, mimetype, fileName, caption })
	}

	/** 
	 * Downloads the media from the current message (if it contains any).
	 * Returns a Buffer representing the file.
	 */
	public async downloadMedia(): Promise<Buffer> {
		if (!this.hasImage && !this.hasVideo && !this.hasAudio && !this.hasSticker) {
			throw new Error('Current message does not contain any downloadable media')
		}

		// Baileys requires the logger and occasionally the options to download media properly
		const buffer = await downloadMediaMessage(
			this.message, 
			'buffer', 
			{}, 
			{ 
				logger: this.bot.logger, 
				reuploadRequest: this.bot.socket?.updateMediaMessage as (msg: WAMessage) => Promise<WAMessage>
			}
		)

		return buffer as Buffer
	}
}
