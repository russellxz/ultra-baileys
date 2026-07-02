import {
	isRepeatedDigitUsernameKey,
	isValidUsernameKey,
	makeRandomUsernameKey,
	makeRepeatedDigitUsernameKey
} from '../../Utils/username'

describe('username key utilities', () => {
	describe('makeRepeatedDigitUsernameKey', () => {
		it('creates a repeated digit key with the default length', () => {
			expect(makeRepeatedDigitUsernameKey({ digit: 1 })).toBe('1111')
			expect(makeRepeatedDigitUsernameKey({ digit: '7' })).toBe('7777')
		})

		it('creates a repeated digit key with a custom length', () => {
			expect(makeRepeatedDigitUsernameKey({ digit: 3, length: 6 })).toBe('333333')
		})

		it('rejects non-digit values', () => {
			expect(() => makeRepeatedDigitUsernameKey({ digit: '12' })).toThrow(/single numeric digit/)
			expect(() => makeRepeatedDigitUsernameKey({ digit: 'a' })).toThrow(/single numeric digit/)
		})
	})

	describe('isValidUsernameKey', () => {
		it('accepts numeric keys with the configured length', () => {
			expect(isValidUsernameKey('1111')).toBe(true)
			expect(isValidUsernameKey('123456', { length: 6 })).toBe(true)
		})

		it('rejects keys with non-digits or the wrong length', () => {
			expect(isValidUsernameKey('111')).toBe(false)
			expect(isValidUsernameKey('11111')).toBe(false)
			expect(isValidUsernameKey('11a1')).toBe(false)
		})
	})

	describe('isRepeatedDigitUsernameKey', () => {
		it('detects repeated digit keys', () => {
			expect(isRepeatedDigitUsernameKey('1111')).toBe(true)
			expect(isRepeatedDigitUsernameKey('222222', { length: 6 })).toBe(true)
			expect(isRepeatedDigitUsernameKey('1234')).toBe(false)
		})
	})

	describe('makeRandomUsernameKey', () => {
		it('creates a numeric key with the default length', () => {
			const key = makeRandomUsernameKey()

			expect(isValidUsernameKey(key)).toBe(true)
		})

		it('creates a numeric key with a custom length', () => {
			const key = makeRandomUsernameKey({ length: 8 })

			expect(isValidUsernameKey(key, { length: 8 })).toBe(true)
		})
	})
})
