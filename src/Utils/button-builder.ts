import type { ButtonSpec } from '../Types'

/**
 * Converts a friendly button spec into the native-flow button format
 * understood by WhatsApp's InteractiveMessage.
 */
export const buildNativeFlowButton = (b: ButtonSpec) => {
	if (b.sections) {
		return {
			name: 'single_select',
			buttonParamsJson: JSON.stringify({
				title: b.text || 'Ver opciones',
				sections: b.sections
			})
		}
	}

	if (b.url) {
		return {
			name: b.useWebview ? 'open_webview' : 'cta_url',
			buttonParamsJson: JSON.stringify(
				b.useWebview
					? { title: b.text, link: { in_app_webview: true, url: b.url } }
					: { display_text: b.text, url: b.url, merchant_url: b.url }
			)
		}
	}

	if (b.copy) {
		return {
			name: 'cta_copy',
			buttonParamsJson: JSON.stringify({
				display_text: b.text,
				id: b.id || b.copy,
				copy_code: b.copy
			})
		}
	}

	if (b.call) {
		return {
			name: 'cta_call',
			buttonParamsJson: JSON.stringify({
				display_text: b.text,
				id: b.id || b.call,
				phone_number: b.call
			})
		}
	}

	return {
		name: 'quick_reply',
		buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id })
	}
}
