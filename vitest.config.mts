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
		testTimeout: 15000,
		projects: [
			{
				test: {
					name: 'workers',
					include: ['tests/**/*.spec.ts'],
					exclude: ['tests/**/*.node.spec.ts'],
					testTimeout: 15000
				},
				plugins: [
					cloudflareTest({
						remoteBindings: false,
						wrangler: { configPath: './wrangler.jsonc' }
					})
				]
			},
			{
				// the workers pool has no filesystem, so source-scanning guards run on node
				test: {
					name: 'node',
					environment: 'node',
					include: ['tests/**/*.node.spec.ts']
				}
			}
		]
	}
});
