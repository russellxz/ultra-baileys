import type { BinaryNode } from '../../WABinary'
import { USyncQuery, USyncUser } from '../../WAUSync'
import { USyncContactProtocol, USyncUsernameProtocol } from '../../WAUSync/Protocols'

describe('USyncUsernameProtocol', () => {
	it('builds a username query element', () => {
		const protocol = new USyncUsernameProtocol()

		expect(protocol.getQueryElement()).toEqual({
			tag: 'username',
			attrs: {}
		})
	})

	it('does not add per-user username content', () => {
		const protocol = new USyncUsernameProtocol()

		expect(protocol.getUserElement(new USyncUser().withId('123@s.whatsapp.net'))).toBeNull()
	})

	it('parses usernames from string and buffer content', () => {
		const protocol = new USyncUsernameProtocol()

		expect(protocol.parser({ tag: 'username', attrs: {}, content: 'alice' })).toBe('alice')
		expect(protocol.parser({ tag: 'username', attrs: {}, content: Buffer.from('bob') })).toBe('bob')
	})
})

describe('USyncContactProtocol', () => {
	it('builds a username contact lookup with optional key and lid', () => {
		const protocol = new USyncContactProtocol()
		const user = new USyncUser().withUsername('alice').withUsernameKey('1234').withLid('111@lid')

		expect(protocol.getUserElement(user)).toEqual({
			tag: 'contact',
			attrs: {
				username: 'alice',
				pin: '1234',
				lid: '111@lid'
			}
		})
	})
})

describe('USyncQuery username parsing', () => {
	it('parses username data alongside contact lookup data', () => {
		const query = new USyncQuery().withContactProtocol().withUsernameProtocol()
		const resultNode: BinaryNode = {
			tag: 'iq',
			attrs: { type: 'result' },
			content: [
				{
					tag: 'usync',
					attrs: {},
					content: [
						{
							tag: 'list',
							attrs: {},
							content: [
								{
									tag: 'user',
									attrs: { jid: '111@lid' },
									content: [
										{ tag: 'contact', attrs: { type: 'in' } },
										{ tag: 'username', attrs: {}, content: Buffer.from('alice') }
									]
								}
							]
						}
					]
				}
			]
		}

		expect(query.parseUSyncQueryResult(resultNode)).toEqual({
			list: [{ id: '111@lid', contact: true, username: 'alice' }],
			sideList: []
		})
	})
})
