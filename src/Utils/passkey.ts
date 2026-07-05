import type { PasskeyRequestState } from '../Types'
import { type BinaryNode, getBinaryNodeChild } from '../WABinary'

export const getPasskeyRequestState = (node: BinaryNode): PasskeyRequestState | undefined => {
	const { type } = node.attrs
	if (type !== 'passkey_prologue_request' && type !== 'crsc_continuation') {
		return
	}

	return {
		notificationType: type,
		hasRequestOptions: !!getBinaryNodeChild(node, 'passkey_request_options')
	}
}
