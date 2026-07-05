import { getPasskeyRequestState } from '../../Utils/passkey'
import type { BinaryNode } from '../../WABinary'

describe('getPasskeyRequestState', () => {
	it('detects passkey prologue requests without exposing challenge data', () => {
		const node: BinaryNode = {
			tag: 'notification',
			attrs: {
				id: 'notif-id',
				from: 's.whatsapp.net',
				type: 'passkey_prologue_request'
			},
			content: [
				{
					tag: 'passkey_request_options',
					attrs: {},
					content: JSON.stringify({
						challenge: 'challenge-value',
						rpId: 'whatsapp.com',
						userVerification: 'required'
					})
				}
			]
		}

		expect(getPasskeyRequestState(node)).toEqual({
			notificationType: 'passkey_prologue_request',
			hasRequestOptions: true
		})
	})

	it('detects CRSC continuation notifications', () => {
		const node: BinaryNode = {
			tag: 'notification',
			attrs: {
				id: 'notif-id',
				from: 's.whatsapp.net',
				type: 'crsc_continuation'
			},
			content: []
		}

		expect(getPasskeyRequestState(node)).toEqual({
			notificationType: 'crsc_continuation',
			hasRequestOptions: false
		})
	})

	it('treats empty passkey request options as present', () => {
		const node: BinaryNode = {
			tag: 'notification',
			attrs: {
				id: 'notif-id',
				from: 's.whatsapp.net',
				type: 'passkey_prologue_request'
			},
			content: [
				{
					tag: 'passkey_request_options',
					attrs: {}
				}
			]
		}

		expect(getPasskeyRequestState(node)).toEqual({
			notificationType: 'passkey_prologue_request',
			hasRequestOptions: true
		})
	})

	it('ignores unrelated notifications', () => {
		const node: BinaryNode = {
			tag: 'notification',
			attrs: {
				id: 'notif-id',
				from: 's.whatsapp.net',
				type: 'server_sync'
			},
			content: []
		}

		expect(getPasskeyRequestState(node)).toBeUndefined()
	})
})
