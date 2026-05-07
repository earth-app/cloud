import { Quest } from '.';

export type CustomQuest = Omit<Quest, 'mobile_only' | 'rarity' | 'premium'> & {
	premium: false;
	owner_id: string;
	custom: true;
	created_at?: string;
	updated_at?: string;
};

export type CustomQuestCreateInput = Omit<
	CustomQuest,
	'id' | 'premium' | 'custom' | 'created_at' | 'updated_at'
>;

export type CustomQuestUpdateInput = Partial<Omit<CustomQuestCreateInput, 'owner_id'>>;

export type CustomQuestMetadata = Pick<CustomQuest, 'id' | 'owner_id' | 'title' | 'reward'>;

export async function getCustomQuests(kv: KVNamespace): Promise<CustomQuestMetadata[]> {
	const quests: CustomQuestMetadata[] = [];
	let list = await kv.list<CustomQuestMetadata>({ prefix: 'custom_quest:' });

	while (true) {
		quests.push(
			...list.keys
				.map((key) => key.metadata)
				.filter((metadata): metadata is CustomQuestMetadata => !!metadata)
		);

		if (list.list_complete) break;

		list = await kv.list<CustomQuestMetadata>({
			prefix: 'custom_quest:',
			cursor: list.cursor
		});
	}

	return quests;
}

export async function getCustomQuest(id: string, kv: KVNamespace): Promise<CustomQuest | null> {
	const quest = await kv.get<CustomQuest>(`custom_quest:${id}`, 'json');
	return quest;
}

export async function getCustomQuestsByOwner(
	owner_id: string,
	kv: KVNamespace
): Promise<CustomQuest[]> {
	const quests = await getCustomQuests(kv);
	const ownedQuests: CustomQuest[] = [];

	for (const questMetadata of quests) {
		if (questMetadata.owner_id === owner_id) {
			const quest = await getCustomQuest(questMetadata.id, kv);
			if (quest) {
				ownedQuests.push(quest);
			}
		}
	}

	return ownedQuests;
}

export async function createCustomQuest(
	quest: CustomQuestCreateInput,
	kv: KVNamespace
): Promise<CustomQuest> {
	const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
	const timestamp = new Date().toISOString();
	const obj: CustomQuest = {
		...quest,
		id,
		premium: false,
		custom: true,
		created_at: timestamp,
		updated_at: timestamp
	};

	// validate steps
	if (!obj.steps || !Array.isArray(obj.steps) || obj.steps.length < 3) {
		throw new Error('A custom quest must have at least 3 steps.');
	}

	if (obj.steps.length > 12) {
		throw new Error('A custom quest cannot have more than 12 steps.');
	}

	for (const step of obj.steps) {
		if (Array.isArray(step)) {
			if (step.length < 2) {
				throw new Error('A multiple choice quest step must have at least 2 options.');
			}

			/// alternates cannot have more than 5 options
			if (step.length > 5) {
				throw new Error('A multiple choice quest step cannot have more than 5 options.');
			}

			for (const option of step) {
				if (!option.type || !option.description || !option.parameters) {
					throw new Error('Each quest step option must have a type, description, and parameters.');
				}

				if (option.description.length > 256) {
					throw new Error('Quest step descriptions cannot exceed 256 characters.');
				}

				/// individual step award cannot exceed 50 when there are alternatives
				if (option.reward && option.reward > 50) {
					throw new Error(
						'An individual quest step with alternatives cannot have a reward greater than 50 points.'
					);
				}
			}
		}

		if (!Array.isArray(step)) {
			if (!step.type || !step.description || !step.parameters) {
				throw new Error('Each quest step must have a type, description, and parameters.');
			}

			if (step.description.length > 256) {
				throw new Error('Quest step descriptions cannot exceed 256 characters.');
			}

			/// individual step award cannot exceed 75
			if (step.reward && step.reward > 75) {
				throw new Error('An individual quest step cannot have a reward greater than 75 points.');
			}
		}
	}

	/// first + last cannot be multiple choice
	if (Array.isArray(obj.steps[0])) {
		throw new Error('The first quest step cannot have multiple choices.');
	}

	if (Array.isArray(obj.steps[obj.steps.length - 1])) {
		throw new Error('The last quest step cannot have multiple choices.');
	}

	/// final reward must be positive / cannot exceed 500 points
	if (obj.reward <= 0 || obj.reward > 500) {
		throw new Error('The total reward for a custom quest must be positive and < 500 points.');
	}

	await kv.put(`custom_quest:${id}`, JSON.stringify(obj), {
		metadata: {
			id,
			owner_id: quest.owner_id,
			title: quest.title,
			reward: quest.reward,
			created_at: timestamp,
			updated_at: timestamp
		}
	});

	return obj;
}

export async function updateCustomQuest(
	id: string,
	updates: CustomQuestUpdateInput,
	kv: KVNamespace
): Promise<CustomQuest | null> {
	const existing = await getCustomQuest(id, kv);
	if (!existing) {
		return null;
	}

	const timestamp = new Date().toISOString();

	const updated: CustomQuest = {
		...existing,
		...updates,
		created_at: existing.created_at,
		updated_at: new Date().toISOString()
	};

	await kv.put(`custom_quest:${id}`, JSON.stringify(updated), {
		metadata: {
			id,
			owner_id: updated.owner_id,
			title: updated.title,
			reward: updated.reward,
			created_at: updated.created_at || timestamp,
			updated_at: timestamp
		}
	});

	return updated;
}

export async function deleteCustomQuest(id: string, kv: KVNamespace): Promise<void> {
	await kv.delete(`custom_quest:${id}`);
}
