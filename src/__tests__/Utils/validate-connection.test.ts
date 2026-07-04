import { proto } from '../../../WAProto'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import type { SignalCreds, SocketConfig, WABrowserDescription } from '../../Types'
import { Browsers } from '../../Utils/browser-utils'
import { generateLoginNode, generateRegistrationNode } from '../../Utils/validate-connection'

const signalCreds: SignalCreds = {
	registrationId: 123,
	signedIdentityKey: {
		public: new Uint8Array(32).fill(1),
		private: new Uint8Array(32).fill(2)
	},
	signedPreKey: {
		keyId: 456,
		keyPair: {
			public: new Uint8Array(32).fill(3),
			private: new Uint8Array(32).fill(4)
		},
		signature: new Uint8Array(64).fill(5)
	}
}

const registrationPayload = (browser: WABrowserDescription, syncFullHistory: boolean) => {
	const config: SocketConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		browser,
		syncFullHistory
	}

	return generateRegistrationNode(signalCreds, config)
}

const loginPayload = (browser: WABrowserDescription, syncFullHistory: boolean) => {
	const config: SocketConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		browser,
		syncFullHistory
	}

	return generateLoginNode('1234567890:1@s.whatsapp.net', config)
}

describe('registration client payload', () => {
	it('uses WIN_HYBRID for Windows Desktop full-history registration', () => {
		const payload = registrationPayload(Browsers.windows('Desktop'), true)

		expect(payload.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
		expect(payload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID)
	})

	it('uses MACOS + DARWIN for macOS Desktop full-history registration', () => {
		const payload = registrationPayload(Browsers.macOS('Desktop'), true)

		expect(payload.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.MACOS)
		expect(payload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN)
	})

	it('keeps browser clients on WEB_BROWSER', () => {
		const payload = registrationPayload(Browsers.ubuntu('Chrome'), true)

		expect(payload.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
		expect(payload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER)
	})

	it('keeps Desktop clients without full history on WEB_BROWSER', () => {
		const payload = registrationPayload(Browsers.windows('Desktop'), false)

		expect(payload.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
		expect(payload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER)
	})

	it('uses the fixed Desktop web sub-platforms when logging in with existing creds', () => {
		const windowsPayload = loginPayload(Browsers.windows('Desktop'), true)
		const macPayload = loginPayload(Browsers.macOS('Desktop'), true)

		expect(windowsPayload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID)
		expect(macPayload.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.MACOS)
		expect(macPayload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN)
	})
})
