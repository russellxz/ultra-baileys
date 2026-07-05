import { jest } from '@jest/globals'
import { randomBytes } from 'crypto'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds } from '../../Types'
import { aesDecryptGCM, Curve, hkdf, sha256 } from '../../Utils/crypto'
import { makeShortcakeFlow } from '../../Utils/shortcake'
import type { BinaryNode } from '../../WABinary/types'

const createMockLogger = () =>
	({
		child: jest.fn().mockReturnThis(),
		trace: jest.fn(),
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		level: 'trace'
	}) as any

const REAL_OPTIONS_B64 =
	'eyJjaGFsbGVuZ2UiOiJGQzZ2Y0pnUC1Pdl82NnlmV2dvaDF3OG1fdHJSOTJCbkZEaGctZTVKRXdrIiwidGltZW91dCI6NjAwMDAwLCJycElkIjoid2hhdHNhcHAuY29tIiwiYWxsb3dDcmVkZW50aWFscyI6W10sInVzZXJWZXJpZmljYXRpb24iOiJyZXF1aXJlZCIsImV4dGVuc2lvbnMiOnsidXZtIjp0cnVlfX0='
const REAL_OPTIONS = new Uint8Array(Buffer.from(REAL_OPTIONS_B64, 'base64'))

const makeFakeCreds = (): AuthenticationCreds =>
	({
		noiseKey: { public: new Uint8Array(32).fill(7), private: new Uint8Array(32) },
		signedIdentityKey: { public: new Uint8Array(32).fill(8), private: new Uint8Array(32) },
		advSecretKey: Buffer.from(new Uint8Array(32).fill(9)).toString('base64')
	}) as unknown as AuthenticationCreds

const iqResult = (content?: BinaryNode['content']): BinaryNode => ({
	tag: 'iq',
	attrs: { type: 'result', id: 'x' },
	content
})

const firstChildTag = (node: BinaryNode): string | undefined =>
	Array.isArray(node.content) ? node.content[0]?.tag : undefined

const leaf = (node: BinaryNode, tag: string): Uint8Array =>
	(node.content as BinaryNode[]).find(c => c.tag === tag)!.content as Uint8Array

describe('Shortcake flow', () => {
	it('completes the handshake driven by the real server notification', async () => {
		let capturedOptions: Uint8Array | null = null
		let prologue: BinaryNode | null = null
		let companionNonce: Uint8Array | null = null
		let envelope: Uint8Array | null = null

		const query = async (node: BinaryNode): Promise<BinaryNode> => {
			switch (firstChildTag(node)) {
				case 'passkey_request_options':
					throw new Error('should not fetch options: they were embedded')
				case 'ref':
					return iqResult([{ tag: 'ref', attrs: {}, content: Buffer.from('the-ref') }])
				case 'passkey_prologue':
					prologue = (node.content as BinaryNode[])[0]!
					return iqResult()
				case 'companion_nonce':
					companionNonce = (node.content as BinaryNode[])[0]!.content as Uint8Array
					return iqResult()
				case 'encrypted_pairing_request':
					envelope = (node.content as BinaryNode[])[0]!.content as Uint8Array
					return iqResult()
				default:
					return iqResult()
			}
		}

		let emittedCode: string | null = null
		let creds = makeFakeCreds()
		const flow = makeShortcakeFlow({
			logger: createMockLogger(),
			query,
			deviceType: proto.DeviceProps.PlatformType.CHROME,
			signAssertion: async options => {
				capturedOptions = options
				return {
					credentialId: Buffer.from('cred-id'),
					webauthnAssertion: Buffer.from('assertion-json')
				}
			},
			getCreds: () => creds,
			updateCreds: patch => {
				creds = { ...creds, ...patch }
			},
			emitVerificationCode: code => (emittedCode = code)
		})

		const prologueRequest: BinaryNode = {
			tag: 'notification',
			attrs: { from: 's.whatsapp.net', type: 'passkey_prologue_request', id: '169361451' },
			content: [{ tag: 'passkey_request_options', attrs: {}, content: REAL_OPTIONS }]
		}
		expect(await flow.handleIncomingNotification(prologueRequest)).toBe(true)

		expect(capturedOptions).toBeTruthy()
		const parsedOptions = JSON.parse(Buffer.from(capturedOptions!).toString('utf-8'))
		expect(parsedOptions.rpId).toBe('whatsapp.com')
		expect(parsedOptions.allowCredentials).toEqual([])
		expect(prologue).toBeTruthy()
		const prologueNode: BinaryNode = prologue!
		expect(new Uint8Array(leaf(prologueNode, 'credential_id'))).toEqual(new Uint8Array(Buffer.from('cred-id')))

		const handoffProof = (prologueNode.content as BinaryNode[]).find(c => c.tag === 'pairing_handoff_proof')
		expect(handoffProof).toBeTruthy()
		expect(new Uint8Array(Buffer.from(creds.advSecretKey, 'base64'))).not.toEqual(new Uint8Array(32).fill(9))

		const prologuePayload = proto.ProloguePayload.decode(leaf(prologueNode, 'prologue_payload'))
		const companionIdentity = proto.CompanionEphemeralIdentity.decode(prologuePayload.companionEphemeralIdentity!)
		const companionPub = new Uint8Array(companionIdentity.publicKey!)
		expect(companionIdentity.ref).toBe('the-ref')

		const primaryKp = Curve.generateKeyPair()
		const primaryNonce = randomBytes(32)
		const primaryBytes = proto.PrimaryEphemeralIdentity.encode({
			publicKey: primaryKp.public,
			nonce: primaryNonce
		}).finish()

		const continuation: BinaryNode = {
			tag: 'notification',
			attrs: { from: 's.whatsapp.net', type: 'crsc_continuation', id: '2' },
			content: [{ tag: 'primary_ephemeral_identity', attrs: {}, content: primaryBytes }]
		}
		expect(await flow.handleIncomingNotification(continuation)).toBe(true)

		expect(companionNonce).toBeTruthy()
		expect(emittedCode).toBeTruthy()
		expect(emittedCode).toBe(flow.getVerificationCode())

		const digest = sha256(Buffer.concat([companionNonce!, primaryKp.public]))
		const codeBytes = new Uint8Array(5)
		for (let i = 0; i < 5; i += 1) codeBytes[i] = primaryNonce[i]! ^ digest[i]!
		const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTVWXYZ'
		let bits = 0
		let val = 0
		let primaryCode = ''
		for (const b of codeBytes) {
			val = (val << 8) | b
			bits += 8
			while (bits >= 5) {
				primaryCode += ALPHABET.charAt((val >>> (bits - 5)) & 31)
				bits -= 5
			}
		}

		if (bits > 0) primaryCode += ALPHABET.charAt((val << (5 - bits)) & 31)

		expect(emittedCode).toBe(primaryCode)

		expect(envelope).toBeTruthy()
		const env = proto.EncryptedPairingRequest.decode(envelope!)
		const sharedFromPrimary = Curve.sharedKey(primaryKp.private, companionPub)
		const salt = Buffer.from(`Companion Pairing ${String(proto.DeviceProps.PlatformType.CHROME)} with ref the-ref`)
		const key = hkdf(sharedFromPrimary, 32, { salt, info: 'Pairing Information Encryption Key' })
		const decrypted = aesDecryptGCM(
			new Uint8Array(env.encryptedPayload!),
			key,
			new Uint8Array(env.iv!),
			Buffer.alloc(0)
		)
		const pairingRequest = proto.PairingRequest.decode(decrypted)
		expect(new Uint8Array(pairingRequest.companionPublicKey!)).toEqual(new Uint8Array(32).fill(7))
		expect(new Uint8Array(pairingRequest.companionIdentityKey!)).toEqual(new Uint8Array(32).fill(8))
		expect(new Uint8Array(pairingRequest.advSecret!)).toEqual(new Uint8Array(Buffer.from(creds.advSecretKey, 'base64')))
	})

	it('returns false for unrecognized notification types', async () => {
		const flow = makeShortcakeFlow({
			logger: createMockLogger(),
			query: async () => iqResult(),
			signAssertion: async () => ({ credentialId: new Uint8Array(), webauthnAssertion: new Uint8Array() }),
			getCreds: () => makeFakeCreds(),
			updateCreds: () => {}
		})

		const unknown: BinaryNode = {
			tag: 'notification',
			attrs: { from: 's.whatsapp.net', type: 'something_else', id: '1' }
		}
		expect(await flow.handleIncomingNotification(unknown)).toBe(false)
	})
})
