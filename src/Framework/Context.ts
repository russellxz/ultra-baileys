import type { WAMessage, AnyMessageContent, MiscMessageGenerationOptions } from '../Types'
import type { Bot, WASocket } from './Bot'
import { MediaManager, type StickerMetadata } from './MediaManager'

export class Context {
	public readonly message: WAMessage
	public readonly bot: Bot
	public readonly remoteJid: string

	/** Extracted text from conversation or extendedTextMessage */
	public get text(): string | undefined {
		return this.message.message?.conversation ||
			this.message.message?.extendedTextMessage?.text ||
			undefined
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
		return this.message.message?.imageMessage?.caption
			|| this.message.message?.videoMessage?.caption
			|| undefined
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
		return this.bot.sendMessage(this.remoteJid, {
			audio: oggBuffer,
			mimetype: 'audio/ogg; codecs=opus',
			ptt: true
		}, { quoted: this.message })
	}

	/** Mark this message as read, with an optional delay */
	public async read(delayMs?: number) {
		if (!this.bot.socket || !this.message.key) return

		if (delayMs && delayMs > 0) {
			await new Promise(resolve => setTimeout(resolve, delayMs))
		}

		return this.bot.socket.readMessages([this.message.key])
	}
}
