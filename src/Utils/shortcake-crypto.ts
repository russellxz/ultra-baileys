import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import type { KeyPair } from '../Types'
import { aesEncryptGCM, Curve, hkdf, sha256 } from './crypto'
import { bytesToCrockford } from './generics'

const NONCE_BYTES = 32
const VERIFICATION_CODE_BYTES = 5
const GCM_IV_BYTES = 12
const ENCRYPTION_KEY_BYTES = 32
const EPHEMERAL_PUBLIC_KEY_BYTES = 32

/** HKDF `info` for the pairing-request encryption key. */
const ENCRYPTION_KEY_INFO = 'Pairing Information Encryption Key'

/**
 * Decoded `PrimaryEphemeralIdentity` the primary device returns: its ephemeral
 * X25519 public key (32B) and a 32B nonce used to derive the verification code.
 */
export interface ShortcakePrimaryEphemeralIdentity {
	readonly publicKey: Uint8Array
	readonly nonce: Uint8Array
}

/**
 * Carries the companion's ephemeral X25519 private key (`keyPair.private`) and
 * the pre-image `companionNonce`. Hold these in memory for the handshake only;
 * never log or `JSON.stringify` an instance.
 */
export interface ShortcakeCompanionEphemeralIdentity {
	/** Companion ephemeral X25519 keypair (private half kept for the ECDH). */
	readonly keyPair: KeyPair
	/** 32 random bytes committed up-front, revealed only after the primary replies. */
	readonly companionNonce: Uint8Array
	/** Encoded `CompanionEphemeralIdentity` proto (committed + sent in the prologue). */
	readonly companionEphemeralIdentityBytes: Uint8Array
	/** `SHA-256(companionEphemeralIdentity ‖ companionNonce)`, the commitment hash. */
	readonly commitmentHash: Uint8Array
	/** Encoded `ProloguePayload` proto ready for the `SetPasskeyPrologue` IQ. */
	readonly prologuePayloadBytes: Uint8Array
}

/**
 * Generates the companion's ephemeral identity + commitment for a Shortcake
 * prologue. The companion publishes a commitment to its nonce now and reveals
 * the nonce later (after the primary's identity arrives) so the primary cannot
 * grind the verification code.
 */
export function generateCompanionEphemeralIdentity(args: {
	readonly ref: string
	readonly deviceType: proto.DeviceProps.PlatformType
}): ShortcakeCompanionEphemeralIdentity {
	const keyPair = Curve.generateKeyPair()
	const companionNonce = randomBytes(NONCE_BYTES)

	const companionEphemeralIdentityBytes = proto.CompanionEphemeralIdentity.encode({
		publicKey: keyPair.public,
		deviceType: args.deviceType,
		ref: args.ref
	}).finish()

	const commitmentHash = sha256(Buffer.concat([companionEphemeralIdentityBytes, companionNonce]))

	const prologuePayloadBytes = proto.ProloguePayload.encode({
		companionEphemeralIdentity: companionEphemeralIdentityBytes,
		commitment: { hash: commitmentHash }
	}).finish()

	return {
		keyPair,
		companionNonce,
		companionEphemeralIdentityBytes,
		commitmentHash,
		prologuePayloadBytes
	}
}

/** Parses + validates a `PrimaryEphemeralIdentity` proto from the primary. */
export function decodePrimaryEphemeralIdentity(bytes: Uint8Array): ShortcakePrimaryEphemeralIdentity {
	const decoded = proto.PrimaryEphemeralIdentity.decode(bytes)
	const publicKey = decoded.publicKey
	const nonce = decoded.nonce
	if (!publicKey || publicKey.length !== EPHEMERAL_PUBLIC_KEY_BYTES) {
		throw new Error('shortcake: PrimaryEphemeralIdentity.publicKey must be 32 bytes')
	}

	if (!nonce || nonce.length !== NONCE_BYTES) {
		throw new Error('shortcake: PrimaryEphemeralIdentity.nonce must be 32 bytes')
	}

	return { publicKey, nonce }
}

/**
 * Derives the short verification code shown on both devices:
 * `Crockford32( primaryNonce[0..5] XOR SHA-256(companionNonce ‖ primaryPubKey)[0..5] )`.
 */
export function deriveVerificationCode(companionNonce: Uint8Array, primary: ShortcakePrimaryEphemeralIdentity): string {
	const digest = sha256(Buffer.concat([companionNonce, primary.publicKey]))
	const code = Buffer.alloc(VERIFICATION_CODE_BYTES)
	for (let i = 0; i < VERIFICATION_CODE_BYTES; i += 1) {
		code[i] = primary.nonce[i]! ^ digest[i]!
	}

	return bytesToCrockford(code)
}

/**
 * Derives the AES-GCM key that protects the pairing request:
 * `HKDF( X25519(companionPriv, primaryPub), salt="Companion Pairing <deviceType> with ref <ref>", info="Pairing Information Encryption Key" )`.
 */
export function deriveEncryptionKey(args: {
	readonly companionPrivKey: Uint8Array
	readonly primaryPublicKey: Uint8Array
	readonly deviceType: proto.DeviceProps.PlatformType
	readonly ref: string
}): Uint8Array {
	const shared = Curve.sharedKey(args.companionPrivKey, args.primaryPublicKey)
	const salt = Buffer.from(`Companion Pairing ${String(args.deviceType)} with ref ${args.ref}`)
	return hkdf(shared, ENCRYPTION_KEY_BYTES, { salt, info: ENCRYPTION_KEY_INFO })
}

/**
 * Encrypts the pairing request plaintext under the derived key and returns the
 * encoded `EncryptedPairingRequest` proto (random 12-byte IV).
 */
export function encryptPairingRequest(encryptionKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
	if (encryptionKey.length !== ENCRYPTION_KEY_BYTES) {
		throw new Error('shortcake: encryption key must be 32 bytes')
	}

	const iv = randomBytes(GCM_IV_BYTES)
	const encryptedPayload = aesEncryptGCM(plaintext, encryptionKey, iv, Buffer.alloc(0))
	return proto.EncryptedPairingRequest.encode({ encryptedPayload, iv }).finish()
}
