import { randomBytes } from 'crypto'
import { proto } from '../../../WAProto/index.js'
import { aesDecryptGCM, Curve, hkdf, sha256 } from '../../Utils/crypto'
import {
	decodePrimaryEphemeralIdentity,
	deriveEncryptionKey,
	deriveVerificationCode,
	encryptPairingRequest,
	generateCompanionEphemeralIdentity
} from '../../Utils/shortcake-crypto'

const DEVICE_TYPE = proto.DeviceProps.PlatformType.CHROME

describe('Shortcake crypto', () => {
	it('companion ephemeral identity carries a verifiable commitment', () => {
		const companion = generateCompanionEphemeralIdentity({ ref: 'test-ref', deviceType: DEVICE_TYPE })

		expect(companion.keyPair.public.length).toBe(32)
		expect(companion.companionNonce.length).toBe(32)
		expect(companion.commitmentHash.length).toBe(32)
		expect(companion.prologuePayloadBytes.length).toBeGreaterThan(0)

		const prologue = proto.ProloguePayload.decode(companion.prologuePayloadBytes)
		expect(new Uint8Array(prologue.companionEphemeralIdentity!)).toEqual(
			new Uint8Array(companion.companionEphemeralIdentityBytes)
		)
		expect(new Uint8Array(prologue.commitment!.hash!)).toEqual(new Uint8Array(companion.commitmentHash))

		expect(
			new Uint8Array(sha256(Buffer.concat([companion.companionEphemeralIdentityBytes, companion.companionNonce])))
		).toEqual(new Uint8Array(companion.commitmentHash))
	})

	it('verification code is deterministic and matches the independent derivation', () => {
		const companionNonce = randomBytes(32)
		const primaryPub = Curve.generateKeyPair().public
		const primaryNonce = randomBytes(32)
		const primaryBytes = proto.PrimaryEphemeralIdentity.encode({
			publicKey: primaryPub,
			nonce: primaryNonce
		}).finish()

		const primary = decodePrimaryEphemeralIdentity(primaryBytes)
		const code = deriveVerificationCode(companionNonce, primary)
		expect(code.length).toBe(8)
		expect(deriveVerificationCode(companionNonce, primary)).toBe(code)

		const digest = sha256(Buffer.concat([companionNonce, primaryPub]))
		const expected = new Uint8Array(5)
		for (let i = 0; i < 5; i += 1) expected[i] = primaryNonce[i]! ^ digest[i]!
		const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTVWXYZ'
		let bitCount = 0
		let value = 0
		let manual = ''
		for (let i = 0; i < expected.length; i += 1) {
			value = (value << 8) | expected[i]!
			bitCount += 8
			while (bitCount >= 5) {
				manual += ALPHABET[(value >>> (bitCount - 5)) & 31]
				bitCount -= 5
			}
		}

		if (bitCount > 0) manual += ALPHABET[(value << (5 - bitCount)) & 31]

		expect(code).toBe(manual)
	})

	it('encryption key agrees with the primary side (ECDH symmetry)', () => {
		const companionKp = Curve.generateKeyPair()
		const primaryKp = Curve.generateKeyPair()
		const ref = 'ecdh-ref'

		const companionKey = deriveEncryptionKey({
			companionPrivKey: companionKp.private,
			primaryPublicKey: primaryKp.public,
			deviceType: DEVICE_TYPE,
			ref
		})

		const sharedFromPrimary = Curve.sharedKey(primaryKp.private, companionKp.public)
		const salt = Buffer.from(`Companion Pairing ${String(DEVICE_TYPE)} with ref ${ref}`)
		const primaryKey = hkdf(sharedFromPrimary, 32, { salt, info: 'Pairing Information Encryption Key' })

		expect(companionKey.length).toBe(32)
		expect(new Uint8Array(companionKey)).toEqual(new Uint8Array(primaryKey))
	})

	it('pairing request envelope round-trips under the derived key', () => {
		const key = randomBytes(32)
		const plaintext = Buffer.from('pairing-data')

		const envelopeBytes = encryptPairingRequest(key, plaintext)
		const envelope = proto.EncryptedPairingRequest.decode(envelopeBytes)
		expect(new Uint8Array(envelope.iv!).length).toBe(12)
		expect(new Uint8Array(envelope.encryptedPayload!).length).toBeGreaterThanOrEqual(plaintext.length)

		const decrypted = aesDecryptGCM(
			new Uint8Array(envelope.encryptedPayload!),
			key,
			new Uint8Array(envelope.iv!),
			Buffer.alloc(0)
		)
		expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(plaintext))
	})

	it('decode rejects malformed primary identity', () => {
		const badPublic = proto.PrimaryEphemeralIdentity.encode({
			publicKey: new Uint8Array(8),
			nonce: new Uint8Array(32)
		}).finish()
		expect(() => decodePrimaryEphemeralIdentity(badPublic)).toThrow(/publicKey must be 32 bytes/)
	})
})
