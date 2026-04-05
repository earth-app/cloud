import { describe, expectTypeOf, it } from 'vitest';

describe('worker-configuration types', () => {
	it('provides the Env interface expected by the worker', () => {
		expectTypeOf<Env>().toHaveProperty('KV');
		expectTypeOf<Env>().toHaveProperty('CACHE');
		expectTypeOf<Env>().toHaveProperty('R2');
		expectTypeOf<Env>().toHaveProperty('AI');
		expectTypeOf<Env>().toHaveProperty('NOTIFIER');
		expectTypeOf<Env>().toHaveProperty('TIMER');
	});
});
