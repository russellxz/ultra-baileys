import { EventEmitter } from 'events'
import { proto } from '../../../WAProto'
import type { BaileysEventEmitter, BaileysEventMap, WAMessage } from '../../Types'
import processMessage, { cleanMessage, getChatId } from '../../Utils/process-message'

const ME_ID = 'me@s.whatsapp.net'

const createBaseMessage = (key: Partial<WAMessage['key']>, message?: Partial<WAMessage['message']>): WAMessage => {
	return {
		key: {
			remoteJid: 'chat@s.whatsapp.net',
			fromMe: false,
			id: 'ABC',
			...key
		},
		message: message || { conversation: 'hello' },
		messageTimestamp: 1675888000
	}
}

describe('cleanMessage', () => {
	const meId = 'me@s.whatsapp.net'
	const meLid = 'me@lid'
	const otherUserId = 'other@s.whatsapp.net'

	describe('JID Normalization', () => {
		it('should correctly normalize a standard phone number JID with a device', () => {
			const message = createBaseMessage({
				remoteJid: '1234567890:15@s.whatsapp.net',
				participant: '9876543210:5@s.whatsapp.net'
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.remoteJid).toBe('1234567890@s.whatsapp.net')
			expect(message.key.participant).toBe('9876543210@s.whatsapp.net')
		})

		it('should not modify a group JID', () => {
			const message = createBaseMessage({
				remoteJid: '123456-7890@g.us'
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.remoteJid).toBe('123456-7890@g.us')
		})

		it('should correctly normalize a LID with a device', () => {
			const message = createBaseMessage({
				participant: '1234567890:12@lid'
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.participant).toBe('1234567890@lid')
		})
	})

	describe('Hosted JID Handling', () => {
		it('should correctly normalize a hosted PN JID back to PN form', () => {
			const hostedJid = '1234567890:99@hosted'
			const message = createBaseMessage({
				remoteJid: hostedJid
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.remoteJid).toBe('1234567890@s.whatsapp.net')
		})

		it('should correctly normalize a hosted LID JID back to LID form', () => {
			const hostedLidJid = '9876543210:99@hosted.lid'
			const message = createBaseMessage({
				participant: hostedLidJid
			})

			cleanMessage(message, meId, meLid)

			expect(message.key.participant).toBe('9876543210@lid')
		})
	})

	describe('Reaction Message Perspective', () => {
		it("should correct the perspective of a reaction to another user's message", () => {
			const message = createBaseMessage(
				{ fromMe: false, participant: otherUserId },
				{
					reactionMessage: {
						key: {
							remoteJid: 'chat@s.whatsapp.net',
							fromMe: false,
							id: 'MSG_THEY_SENT',
							participant: otherUserId
						},
						text: '😂'
					}
				}
			)

			cleanMessage(message, meId, meLid)

			const reactionKey = message.message!.reactionMessage!.key!
			expect(reactionKey.fromMe).toBe(false)
		})

		it('should not modify a reaction on a message I sent from another device', () => {
			const message = createBaseMessage(
				{ fromMe: true },
				{
					reactionMessage: {
						key: { remoteJid: 'chat@s.whatsapp.net', fromMe: true, id: 'MSG_I_SENT' },
						text: '❤️'
					}
				}
			)

			const originalReactionKey = { ...message.message!.reactionMessage!.key! }

			cleanMessage(message, meId, meLid)

			const reactionKey = message.message!.reactionMessage!.key!
			expect(reactionKey).toEqual(originalReactionKey)
		})
	})

	describe('Edge Cases', () => {
		it('should not crash if JIDs are undefined', () => {
			const message = createBaseMessage({
				remoteJid: undefined,
				participant: undefined
			})

			expect(() => cleanMessage(message, meId, meLid)).not.toThrow()
		})

		it('should not crash on an empty message object', () => {
			const message = createBaseMessage({}, {})
			expect(() => cleanMessage(message, meId, meLid)).not.toThrow()
		})
	})
})

describe('processMessage', () => {
	it('emits link-preview.update for phone-generated link preview responses', async () => {
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		let emitted: BaileysEventMap['link-preview.update'] | undefined
		ev.on('link-preview.update', update => {
			emitted = update
		})

		const linkPreview = {
			url: 'https://example.com/',
			title: 'Example',
			thumbData: Buffer.from([1, 2, 3]),
			hqThumbnail: {
				directPath: '/o1/v/t62.7118-24/link-preview',
				thumbHash: Buffer.from('thumb-hash').toString('base64'),
				encThumbHash: Buffer.from('enc-thumb-hash').toString('base64'),
				mediaKey: Buffer.from('media-key'),
				mediaKeyTimestampMs: 1_692_895_570_000,
				thumbWidth: 1200,
				thumbHeight: 630
			}
		}

		const message = createBaseMessage(
			{ remoteJid: ME_ID, fromMe: true },
			{
				protocolMessage: {
					type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
					peerDataOperationRequestResponseMessage: {
						stanzaId: 'PDO_REQUEST_ID',
						peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.GENERATE_LINK_PREVIEW,
						peerDataOperationResult: [{ linkPreviewResponse: linkPreview }]
					}
				}
			}
		)

		type ProcessMessageContext = Parameters<typeof processMessage>[1]
		await processMessage(message, {
			shouldProcessHistoryMsg: false,
			ev,
			creds: { me: { id: ME_ID } } as ProcessMessageContext['creds'],
			keyStore: {} as ProcessMessageContext['keyStore'],
			logger: undefined,
			options: {},
			signalRepository: {} as ProcessMessageContext['signalRepository'],
			getMessage: async () => undefined
		})

		expect(emitted).toEqual({
			stanzaId: 'PDO_REQUEST_ID',
			linkPreview
		})
	})
})

describe('getChatId', () => {
	it('returns remoteJid for a regular 1:1 chat', () => {
		expect(getChatId({ remoteJid: 'peer@s.whatsapp.net', fromMe: false, id: 'X' })).toBe('peer@s.whatsapp.net')
	})

	it('returns remoteJid for a group chat (broadcast check is false)', () => {
		expect(getChatId({ remoteJid: '120363@g.us', fromMe: false, id: 'X' })).toBe('120363@g.us')
	})

	it('returns remoteJid for status broadcast (status is special-cased to remoteJid)', () => {
		expect(
			getChatId({
				remoteJid: 'status@broadcast',
				participant: 'someone@s.whatsapp.net',
				fromMe: false,
				id: 'X'
			})
		).toBe('status@broadcast')
	})

	it('returns participant for non-status broadcast received from peer', () => {
		expect(
			getChatId({
				remoteJid: '12345@broadcast',
				participant: 'sender@s.whatsapp.net',
				fromMe: false,
				id: 'X'
			})
		).toBe('sender@s.whatsapp.net')
	})

	it('returns remoteJid for non-status broadcast sent by me', () => {
		expect(
			getChatId({
				remoteJid: '12345@broadcast',
				participant: 'me@s.whatsapp.net',
				fromMe: true,
				id: 'X'
			})
		).toBe('12345@broadcast')
	})

	it('throws when remoteJid is missing', () => {
		expect(() => getChatId({ fromMe: false, id: 'X' })).toThrow(/missing remoteJid/)
	})

	it('throws when broadcast key has no participant', () => {
		expect(() => getChatId({ remoteJid: '12345@broadcast', fromMe: false, id: 'X' })).toThrow(/missing participant/)
	})
})
