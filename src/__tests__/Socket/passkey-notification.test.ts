import { jest } from '@jest/globals'
import { emitPasskeyRequestUpdate } from '../../Socket/messages-recv'
import type { BaileysEventEmitter } from '../../Types'
import type { ILogger } from '../../Utils/logger'
import type { BinaryNode } from '../../WABinary'

const makeEventEmitter = () =>
	({
		emit: jest.fn()
	}) as unknown as BaileysEventEmitter

const makeLogger = () =>
	({
		info: jest.fn()
	}) as unknown as ILogger

describe('emitPasskeyRequestUpdate', () => {
	it.each([
		{
			type: 'passkey_prologue_request',
			content: [{ tag: 'passkey_request_options', attrs: {} }],
			expected: { notificationType: 'passkey_prologue_request', hasRequestOptions: true }
		},
		{
			type: 'crsc_continuation',
			content: [],
			expected: { notificationType: 'crsc_continuation', hasRequestOptions: false }
		}
	])('emits connection.update for $type notifications', ({ type, content, expected }) => {
		const ev = makeEventEmitter()
		const logger = makeLogger()

		emitPasskeyRequestUpdate(
			{
				tag: 'notification',
				attrs: {
					id: 'notif-id',
					from: 's.whatsapp.net',
					type
				},
				content
			},
			ev,
			logger
		)

		expect(ev.emit).toHaveBeenCalledWith('connection.update', { passkeyRequest: expected })
		expect(logger.info).toHaveBeenCalledWith(expected, 'received passkey companion-linking request')
	})

	it('ignores unsupported notification types', () => {
		const ev = makeEventEmitter()
		const logger = makeLogger()
		const node: BinaryNode = {
			tag: 'notification',
			attrs: {
				id: 'notif-id',
				from: 's.whatsapp.net',
				type: 'server_sync'
			}
		}

		emitPasskeyRequestUpdate(node, ev, logger)

		expect(ev.emit).not.toHaveBeenCalled()
		expect(logger.info).not.toHaveBeenCalled()
	})
})
