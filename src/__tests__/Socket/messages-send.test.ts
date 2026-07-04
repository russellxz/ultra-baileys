import { jest } from '@jest/globals'
import { resolveMessageSendJid } from '../../Socket/messages-send'

describe('resolveMessageSendJid', () => {
	it('should route a PN send to its locally mapped LID', async () => {
		const getStoredLIDForPN = jest.fn(async (): Promise<string | null> => '98765@lid')

		const result = await resolveMessageSendJid('12345@s.whatsapp.net', getStoredLIDForPN)

		expect(result).toEqual({
			jid: '98765@lid',
			remoteJidAlt: '12345@s.whatsapp.net',
			addressingMode: 'lid',
			additionalAttributes: {
				addressing_mode: 'lid',
				recipient_pn: '12345@s.whatsapp.net'
			}
		})
		expect(getStoredLIDForPN).toHaveBeenCalledWith('12345@s.whatsapp.net')
	})

	it('should keep the PN destination when no local LID mapping exists', async () => {
		const getStoredLIDForPN = jest.fn(async (): Promise<string | null> => null)

		const result = await resolveMessageSendJid('12345@s.whatsapp.net', getStoredLIDForPN)

		expect(result).toEqual({ jid: '12345@s.whatsapp.net' })
	})

	it('should route a hosted PN send to its locally mapped hosted LID', async () => {
		const getStoredLIDForPN = jest.fn(async (): Promise<string | null> => '98765@hosted.lid')

		const result = await resolveMessageSendJid('12345@hosted', getStoredLIDForPN)

		expect(result).toEqual({
			jid: '98765@hosted.lid',
			remoteJidAlt: '12345@hosted',
			addressingMode: 'lid',
			additionalAttributes: {
				addressing_mode: 'lid',
				recipient_pn: '12345@hosted'
			}
		})
		expect(getStoredLIDForPN).toHaveBeenCalledWith('12345@hosted')
	})

	it('should keep non-PN destinations unchanged without checking LID mappings', async () => {
		const getStoredLIDForPN = jest.fn(async (): Promise<string | null> => {
			throw new Error('unexpected LID lookup')
		})

		const result = await resolveMessageSendJid('98765@lid', getStoredLIDForPN)

		expect(result).toEqual({ jid: '98765@lid' })
		expect(getStoredLIDForPN).not.toHaveBeenCalled()
	})

	it('should keep the PN destination when the stored value is not a LID', async () => {
		const getStoredLIDForPN = jest.fn(async (): Promise<string | null> => '98765@s.whatsapp.net')

		const result = await resolveMessageSendJid('12345@s.whatsapp.net', getStoredLIDForPN)

		expect(result).toEqual({ jid: '12345@s.whatsapp.net' })
	})
})
