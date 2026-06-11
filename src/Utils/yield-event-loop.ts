export async function yieldEventLoop() {
	return new Promise(resolve => setImmediate(resolve))
}
