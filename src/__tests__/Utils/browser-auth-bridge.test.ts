import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	type BrowserAuthExtract,
	extractWhatsAppWebAuthFromBrowser,
	makeBrowserAuthImport,
	writeBrowserAuthToMultiFile
} from '../../Utils/browser-auth-bridge'
import { Curve } from '../../Utils/crypto'

const asB64 = (value: Uint8Array) => Buffer.from(value).toString('base64')
const asBufferJson = (value: Uint8Array) => ({ __b64: asB64(value) })

const makeExtract = () => {
	const noiseKey = Curve.generateKeyPair()
	const signedIdentityKey = Curve.generateKeyPair()
	const signedPreKey = Curve.generateKeyPair()
	const preKey = Curve.generateKeyPair()
	const wrongPrivate = Curve.generateKeyPair()
	const wrongPublic = Curve.generateKeyPair()

	const extract: BrowserAuthExtract = {
		localStorage: {
			lastWidMd: '15551234567:10@c.us',
			waLid: '1234567890:10@lid'
		},
		noise: {
			privateKeyCandidates: [
				{ ivIndex: 0, value: asB64(wrongPrivate.private) },
				{ ivIndex: 2, value: asB64(noiseKey.private) }
			],
			publicKeyCandidates: [
				{ ivIndex: 1, value: asB64(noiseKey.public) },
				{ ivIndex: 3, value: asB64(wrongPublic.public) }
			],
			recoveryTokenCandidates: [
				{ ivIndex: 0, value: Buffer.from('recovery-token').toString('base64') },
				{ ivIndex: 1, value: Buffer.from('wrong-token').toString('base64') }
			],
			certificateChainBufferCandidates: [
				{ ivIndex: 3, value: Buffer.from(JSON.stringify({ leaf: { key: 'unused' } })).toString('base64') }
			]
		},
		signal: {
			registrationId: 1234,
			nextPreKeyId: 2,
			firstUnuploadedPreKeyId: 2,
			lastSignedPreKeyId: 1,
			signedIdentityKey: {
				private: asB64(signedIdentityKey.private),
				public: asB64(signedIdentityKey.public)
			},
			advSignedIdentity: {
				details: asBufferJson(Buffer.from('details')),
				accountSignatureKey: asBufferJson(Buffer.from('account-signature-key')),
				accountSignature: asBufferJson(Buffer.from('account-signature')),
				deviceSignature: asBufferJson(Buffer.from('device-signature'))
			},
			preKeys: [
				{
					keyId: 1,
					keyPair: {
						privKey: asBufferJson(preKey.private),
						pubKey: asBufferJson(preKey.public)
					}
				}
			],
			signedPreKeys: [
				{
					keyId: 1,
					keyPair: {
						privKey: asBufferJson(signedPreKey.private),
						pubKey: asBufferJson(signedPreKey.public)
					}
				}
			]
		}
	}

	return { extract, noiseKey, preKey }
}

describe('makeBrowserAuthImport', () => {
	it('selects the matching Noise key pair from scrambled IV candidates', () => {
		const { extract, noiseKey, preKey } = makeExtract()

		const authImport = makeBrowserAuthImport(extract, { name: 'Bridge Test' })

		expect(Buffer.from(authImport.creds.noiseKey.private).equals(Buffer.from(noiseKey.private))).toBe(true)
		expect(Buffer.from(authImport.creds.noiseKey.public).equals(Buffer.from(noiseKey.public))).toBe(true)
		expect(authImport.selectedNoiseCandidate).toEqual({
			privateIvIndex: 2,
			publicIvIndex: 1,
			recoveryTokenIvIndex: 0
		})
		expect(authImport.creds.advSecretKey).toBe(Buffer.from('recovery-token').toString('base64'))
		expect(authImport.creds.me).toEqual({
			id: '15551234567:10@s.whatsapp.net',
			lid: '1234567890:10@lid',
			name: 'Bridge Test'
		})
		expect(authImport.keys['pre-key']?.[1]).toEqual({
			private: preKey.private,
			public: preKey.public
		})
		expect(authImport.keys['lid-mapping']).toEqual({
			15551234567: '1234567890',
			'1234567890_reverse': '15551234567'
		})
	})

	it('rejects exports without a recovery token', () => {
		const { extract } = makeExtract()
		delete extract.noise.recoveryTokenCandidates

		expect(() => makeBrowserAuthImport(extract)).toThrow('recovery token')
	})

	it('rejects exports when lastSignedPreKeyId does not match a signed pre-key', () => {
		const { extract } = makeExtract()
		extract.signal.lastSignedPreKeyId = 404

		expect(() => makeBrowserAuthImport(extract)).toThrow('signed pre-key')
	})
})

describe('writeBrowserAuthToMultiFile', () => {
	it('writes the expected auth files with owner-only permissions', async () => {
		const folder = await mkdtemp(join(tmpdir(), 'baileys-browser-auth-'))
		try {
			const { extract } = makeExtract()

			await writeBrowserAuthToMultiFile(folder, extract, { name: 'Bridge Test' })

			const credsPath = join(folder, 'creds.json')
			const preKeyPath = join(folder, 'pre-key-1.json')
			const lidMappingPath = join(folder, 'lid-mapping-15551234567.json')
			const reverseLidMappingPath = join(folder, 'lid-mapping-1234567890_reverse.json')

			await expect(readFile(credsPath, 'utf-8')).resolves.toContain('"advSecretKey":"cmVjb3ZlcnktdG9rZW4="')
			await expect(readFile(preKeyPath, 'utf-8')).resolves.toContain('"private"')
			await expect(readFile(lidMappingPath, 'utf-8')).resolves.toContain('"1234567890"')
			await expect(readFile(reverseLidMappingPath, 'utf-8')).resolves.toContain('"15551234567"')
			expect((await stat(folder)).mode & 0o777).toBe(0o700)
			expect((await stat(credsPath)).mode & 0o777).toBe(0o600)
			expect((await stat(preKeyPath)).mode & 0o777).toBe(0o600)
		} finally {
			await rm(folder, { force: true, recursive: true })
		}
	})
})

describe('extractWhatsAppWebAuthFromBrowser', () => {
	it('fails fast when required browser localStorage is missing', async () => {
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			value: {
				getItem: () => null
			}
		})

		await expect(extractWhatsAppWebAuthFromBrowser()).rejects.toThrow('last-wid-md')
	})
})
