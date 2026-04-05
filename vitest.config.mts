import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		maxWorkers: 1,
		coverage: {
			provider: 'istanbul'
		}
	},
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			wrangler: { configPath: './wrangler.jsonc' }
		})
	]
});
