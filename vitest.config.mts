import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const localMaxWorkers = 2;

export default defineConfig({
	test: {
		maxWorkers: process.env.CI ? 1 : localMaxWorkers,
		coverage: {
			provider: 'istanbul',
			include: ['src/**/*.ts'],
			exclude: ['tests/helpers/**', '**/*.d.ts']
		},
		testTimeout: 15000
	},
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			wrangler: { configPath: './wrangler.jsonc' }
		})
	]
});
