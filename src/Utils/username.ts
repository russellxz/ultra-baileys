import { randomInt } from 'crypto'

const DEFAULT_USERNAME_KEY_LENGTH = 4
const DIGIT_REGEX = /^\d$/

export type UsernameKeyOptions = {
	/** Defaults to 4, matching WhatsApp's current username key shape. */
	length?: number
}

export type RepeatedDigitUsernameKeyOptions = UsernameKeyOptions & {
	digit: string | number
}

const assertUsernameKeyLength = (length: number) => {
	if (!Number.isInteger(length) || length <= 0) {
		throw new Error('Username key length must be a positive integer')
	}
}

const normalizeDigit = (digit: string | number) => {
	const value = digit.toString()
	if (!DIGIT_REGEX.test(value)) {
		throw new Error('Username key digit must be a single numeric digit')
	}

	return value
}

export const isValidUsernameKey = (key: string, { length = DEFAULT_USERNAME_KEY_LENGTH }: UsernameKeyOptions = {}) => {
	assertUsernameKeyLength(length)
	return key.length === length && /^\d+$/.test(key)
}

export const isRepeatedDigitUsernameKey = (
	key: string,
	{ length = DEFAULT_USERNAME_KEY_LENGTH }: UsernameKeyOptions = {}
) => {
	if (!isValidUsernameKey(key, { length })) {
		return false
	}

	return key.split('').every(digit => digit === key[0])
}

export const makeRepeatedDigitUsernameKey = ({
	digit,
	length = DEFAULT_USERNAME_KEY_LENGTH
}: RepeatedDigitUsernameKeyOptions) => {
	assertUsernameKeyLength(length)
	return normalizeDigit(digit).repeat(length)
}

export const makeRandomUsernameKey = ({ length = DEFAULT_USERNAME_KEY_LENGTH }: UsernameKeyOptions = {}) => {
	assertUsernameKeyLength(length)
	return Array.from({ length }, () => randomInt(10).toString()).join('')
}
