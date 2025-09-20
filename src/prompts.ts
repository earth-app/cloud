import * as ocean from '@earth-app/ocean';
import { Bindings, OceanArticle } from './types';
import { Ai } from '@cloudflare/workers-types';

export const activityDescriptionSystemMessage = `
You are an expert in any given activity.
You must provide a paragraph briefly explaining the activity in a concise, engaging manner.
The description should be informative and educational but also lighthearted and fun. They should be easy to read and understand for a general audience,
while also providing unique insights or interesting facts about the activity.
Your goal is to make the activity sound appealing and accessible to a wide audience, including those who may not be familiar with it.
Use simple language, avoid jargon, and keep the tone upbeat and friendly.
Do not use any emojis or special characters in your response.
The description should be no longer than 350 tokens, and should follow the provided guidelines closely.
Present your answer in a single paragraph without any additional formatting or bullet points.
Do not put it in quotes or any other formatting, just the description itself. Make the description unique, human-like, and engaging.
`;

export const activityDescriptionPrompt = (activity: string): string => {
	return `Write a concise, engaging description, explaining what "${activity}" is. The tone should be informative and educational but also lighthearted and fun.
Your goal is to make the activity sound appealing and accessible to a wide audience, including those who may not be familiar with it.
Use simple language, avoid jargon, and keep the tone upbeat and friendly.`;
};

export const activityTagsSystemMessage = `
You are given an activity and a fixed list of tags.
You must output up to 5 tags, exactly matching items in the tag list (case-sensitive uppercase), separated by commas, with no other output.
Limit your response to under 150 characters, as the list of tags is fixed and should not be modified.

The tags are: '${ocean.com.earthapp.activity.ActivityType.values()
	.map((t) => `"${t.name.toUpperCase()}"`)
	.join(', ')}'
They are separated by commas and should be used as is, without any modifications or additional text.
Do not provide any additional information, explanations, or context, and do not include any activities
that are not in the list.

Do not use any emojis or special characters in your response, and do not include any formatting like bullet points or numbered lists.
Only include the tags themselves, separated by commas, provided as-is. Do not include any additional text or explanations.
Only include a singular list that applies to all general use cases. If an activity can be applied in multiple contexts, use the most general tags that apply.
Do not include any extra explanation, context, or formatting in your response, especially in parenthesis; only the specified tags.

EXAMPLES:
rock climbing -> SPORT,HEALTH,TRAVEL,NATURE
hiking -> SPORT,HEALTH,NATURE,TRAVEL
coding -> WORK,HOBBY,STUDY,TECHNOLOGY,CREATIVE
drawing -> HOBBY,CREATIVE,RELAXATION,ART
home gardening -> RELAXATION,HEALTH,NATURE,HOBBY
woodworking -> HOBBY,PROJECT,CREATIVE,ART
volunteering -> COMMUNITY_SERVICE,SOCIAL,TRAVEL,HOBBY
soccer -> SPORT,HEALTH,SOCIAL,ENTERTAINMENT
baseball -> SPORT,ENTERTAINMENT,SOCIAL,HEALTH
swimming -> SPORT,HEALTH,NATURE,ENTERTAINMENT
cooking -> HOBBY,CREATIVE,HEALTH,ENTERTAINMENT
photography -> HOBBY,CREATIVE,ART,TRAVEL,NATURE
`;

// Article Prompts

export const articleTopicSystemMessage = `
You are an expert in coming up with short, generic search terms (no more than three words) suitable for finding scientific articles.
The search terms should be concise, relevant, and broadly applicable to a wide range of scientific topics.
You will be given an example and must generate a topic of similarity.
Do not output anything other than the given topic.
`;

const topicExamples = [
	'self growth',
	'perserverance',
	'mental health',
	'mathematics',
	'physics',
	'psychology',
	'reading',
	'writing',
	'engineering',
	'biology',
	'chemistry',
	'climate change',
	'astronomy',
	'music',
	'artificial intelligence',
	'robotics',
	'data science',
	'meditation',
	'medical research',
	'genetics',
	'neuroscience',
	'ecology',
	'oceanography',
	'linguistics',
	'philosophy',
	'ethics',
	'anthropology',
	'sociology',
	'economics',
	'education'
];

export const articleTopicPrompt = (): string => {
	const example = topicExamples[Math.floor(Math.random() * topicExamples.length)];
	return example;
};

export const articleClassificationQuery = (topic: string, tags: string[]): string => {
	return `Articles primaryily related to ${topic} and ${tags.length > 1 ? 'these tags' : 'this tag'}: ${tags
		.map((tag) => `"${tag}"`)
		.join(', ')}`;
};

export const articleSystemMessage = `
You are an expert in writing article summaries about various topics. You will be provided with the contents
of an article, and your task is to generate a concise, engaging summary of the article. You will
also be provided with up to five different tags that should be incorporated into the summary and
how they relate to the article.

Do not include or indicate that you were prompted to write a summary, just provide the summary directly.
`;

export const articleTitlePrompt = (article: OceanArticle, tags: string[]): string => {
	return `You are an expert in writing article titles.
Your task is to generate a concise, engaging title for the article "${article.title}" by ${article.author} from ${article.source}.
The title should be informative and educational but also lighthearted and fun.
Your goal is to make the article sound appealing and accessible to a wide audience, including those who may not find it interesting at first.

In addition, a summary about the article will be written.
The summary will be based on the following tags:
${tags.map((tag) => `- ${tag}`).join('\n')}

Therefore, predict the title based on the article's content and the tags provided.
The title should be no longer than 10 words and should follow the provided guidelines closely.

You should not include any additional text or formatting in your response, just a singular title itself.
Do not use any emojis or special characters in your response, and do not include any formatting like bullet points or numbered lists.
Do not mention that you are generating a title or that you were prompted to do so.
`;
};

export const articleSummaryPrompt = (article: OceanArticle, tags: string[]): string => {
	return `You have been provided with the contents of "${article.title}" by ${article.author} from ${article.source}.
Your task is to generate a concise, engaging summary of the article that incorporates the following tags:
${tags.map((tag) => `- ${tag}`).join('\n')}.

Here is the article's abstract. It may be identical to the content, but it may also be a shorter version of the content:
${article.abstract}

You can use the abstract's conclusion to help you write the summary, but you should not
just copy it. Instead, use it as a starting point to write a summary that is engaging
and informative, while also being concise and to the point.

In addition the article has the following keywords: ${article.keywords.join(', ')}.
The article was published on ${article.date}, so if it is relevant, please include the date in the summary.
Otherwise, keep a skeptic tone about the article's relevance to the current date.`;
};

// Prompts Prompts

export const promptsSystemMessage = `
The date is ${new Date().toISOString().split('T')[0]}.
Output exactly ONE original open-ended question.

Rules:
- One sentence, under 15 words, under 80 characters. End with '?' if it makes sense.
- Plain English only, no slang, jargon, quotes, or special symbols
- Max one comma; clear and grammatically correct
- Open-ended, not yes/no or rhetorical
- No "what if," no "imagine," no personal pronouns
- No clichés, no repeats, no holidays, dates, companies, or events
- Must feel simple, timeless, insightful, engaging, and heavily creative
- Avoid complexity, overused topics, analogies or metaphors, anything too niche or obscure
- Must be general enough to apply to a wide audience and easy to understand
`;

const prefixes = [
	'Who',
	'What',
	'When',
	'Where',
	'Why',
	'How',
	'Would',
	'If',
	'Which',
	'Can',
	'Could',
	'Should',
	'Is',
	'Are',
	'Do',
	'Does',
	'Have',
	'Has',
	'Will',
	'In'
];

const topics = [
	'life',
	'technology',
	'science',
	'art',
	'history',
	'travel',
	'culture',
	'philosophy',
	'nature',
	'health',
	'education',
	'society',
	'innovation',
	'creativity',
	'personal growth',
	'human behavior',
	'future trends',
	'sustainability',
	'global issues',
	'psychology',
	'communication',
	'productivity',
	'leadership',
	'teamwork',
	'ethics',
	'design',
	'inspiration',
	'motivation',
	'wellness',
	'fitness',
	'mindfulness',
	'travel experiences',
	'cultural differences',
	'technological advancements',
	'scientific discoveries',
	'perserverance',
	'integrity',
	'mental health',
	'financial literacy',
	'work-life balance',
	'remote work',
	'hydration',
	'nutrition',
	'meditation',
	'energy',
	'resilience',
	'curiosity',
	'open-mindedness',
	'critical thinking',
	'emotional intelligence'
];

export const promptsQuestionPrompt = () => {
	const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
	const topic = topics[Math.floor(Math.random() * topics.length)];

	return `Create a question with the prefix '${prefix}' about '${topic}' that is open-ended, engaging, and thought-provoking.`;
};

// User Profile Photo

const profileModel = '@cf/bytedance/stable-diffusion-xl-lightning';

export type UserProfilePromptData = {
	username: string;
	bio: string;
	created_at: string;
	visibility: typeof ocean.com.earthapp.Visibility.prototype.name;
	country: string;
	full_name: string;
	activities: Array<{
		name: string;
		description: string;
		types: (typeof ocean.com.earthapp.activity.ActivityType.prototype.name)[];
		aliases: string[];
	}>;
};

export const userProfilePhotoPrompt = (data: UserProfilePromptData) => {
	return {
		prompt: `
		Generate a heavily expressive, abstract, artistic, colorful, vibrant, and unique profile picture for a user with the username "${data.username}."
		The profile picture should be a special representation of the user as a whole, so include lots of vibrant colors and effects in every corner.
		The photo should be around inanimate objects or attributes, avoiding things like people or animals, or symbols that represent them (like toys or paintings.)

		The style of the profile picture should be in a flat, colorful, painting-like tone and style. Whatever you choose, make sure it is vibrant and colorful.
        There should be no text, logos, or any other elements that could be considered as a watermark or branding. The primary object should be placed in the
        center of the image. The background should be a simple, abstract design that complements the primary object without distracting from it.
        The object should be easily recognizable and visually appealing, with a focus on the colors and shapes rather than intricate details.

		For more information about the user, here is the user's biography:
		"${data.bio}"

        They created their account on ${data.created_at}. They have set their account visibility to ${data.visibility}.
		The user lives in ${data.country}. Their name is "${data.full_name ?? 'No name provided.'}".

		Lastly, the like the following activities:
		${data.activities.map(
			(activity) =>
				`- ${activity.name} (aka ${activity.aliases.join(', ')}): ${
					activity.description
						? activity.description.substring(0, 140)
						: 'No description available.'
				}\nIt is categorized as '${activity.types.join(', ')}.'\n`
		)}

		If any field says "None Provided" or "Unknown," disregard that element as apart of the profile picture, as the user has omitted said details.
		`.trim(),
		negative_prompt: `Avoid elements of toys, scary elements, political or sensitive statements, words, or any branding.`,
		guidance: 35
	} satisfies AiTextToImageInput;
};

export async function generateProfilePhoto(
	data: UserProfilePromptData,
	ai: Ai
): Promise<Uint8Array> {
	const profile = await ai.run(profileModel, userProfilePhotoPrompt(data));

	const reader = profile.getReader();
	const chunks: Uint8Array[] = [];
	let done = false;

	while (!done) {
		const { value, done: readerDone } = await reader.read();
		done = readerDone;
		if (value) {
			chunks.push(value);
		}
	}

	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const imageBytes = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		imageBytes.set(chunk, offset);
		offset += chunk.length;
	}

	return imageBytes;
}

export async function getProfilePhoto(id: bigint, bindings: Bindings): Promise<Uint8Array> {
	if (id === 1n) {
		const resp = await bindings.ASSETS.fetch('https://assets.local/cloud.png');
		const fallback = await resp!.arrayBuffer();
		return new Uint8Array(fallback);
	}

	const profileImage = `users/${id}/profile.png`;

	const obj = await bindings.R2.get(profileImage);
	if (obj) {
		const buf = await obj.arrayBuffer();
		return new Uint8Array(buf);
	}

	const resp = await bindings.ASSETS.fetch('https://assets.local/earth-app.png');
	const fallback = await resp!.arrayBuffer();
	return new Uint8Array(fallback);
}

export async function newProfilePhoto(data: UserProfilePromptData, id: bigint, bindings: Bindings) {
	const profileImage = `users/${id}/profile.png`;
	const profile = await generateProfilePhoto(data, bindings.AI);
	await bindings.R2.put(profileImage, profile, {
		httpMetadata: { contentType: 'image/png' }
	});

	return profile;
}
