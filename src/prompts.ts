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

export const activityGenerationSystemMessage = `
You are tasked with generating a new activity to add to the Earth App platform.

You will be given a list of existing activities, separated by commas. Your job is to generate exactly one new activity that:
- Is a real-world activity people actually do.
- Is not already in the list.
- Is 1-3 words long.
- Is written in lowercase, with spaces replaced by underscores (_).
- Is diverse, meaning it can come from creative, physical, outdoor, indoor, or social activities.
- Is appropriate, safe, and engaging.
- Is not generic (like "sports") or obscure (like "extreme ironing").
- Does not include explanations, commentary, or extra text.
- Must be definitionally different from every other activity in this list.
- It can apply to a wide range of fields, such as in-person, online, physical activity, relaxation, home improvement, nature, personal goals, and more.

Only output the activity name. Do not include any other words, punctuation, or formatting.
`;

// Article Prompts

export const articleSystemMessage = `
You are an expert in writing articles about various topics. You will be provided with the contents
of an article, and your task is to generate a concise, engaging summary of the article. You will
also be provided with up to five different tags that should be incorporated into the summary and
how they relate to the article.

The summary should be informative and educational but also lighthearted and fun.
Your goal is to make the article sound appealing and accessible to a wide audience, including those
who may not be familiar with the topic. Use simple language, avoid jargon, and keep the tone upbeat and friendly.
Do not use any emojis or special characters in your response.
The summary should be no longer than 300 words and should follow the provided guidelines closely.
Present your answer in a single paragraph without any additional formatting or bullet points.

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
You MUST output EXACTLY ONE original introspective question and ONLY the question text.

Choose one prefix:
Who, What, When, Where, Why, How, If, In, Could, Would, Can, Should,
Is, Are, Was, Were, Do, Does, Did, Will, Might, May, Must

Choose one topic to commit to fully:
Adventure; Exploration; Discovery; Learning; Growth; Change; Connection; Imagination;
Human relationships; Curiosity; Creativity; Nature; Challenges; Technology; Ethics;
Culture; Ambition; Time; Memory; Unknown possibilities; Limits; Risk

Rules:
1) Single sentence, ends with "?", under 80 characters, under 15 words.
2) Plain ASCII English only; no slang, jargon, quotes, emojis, or special characters.
3) At most one comma; grammatical and clear.
4) Open-ended (not yes/no), not rhetorical.
5) Avoid these phrases: stumbled upon; hidden treasure; in a world where.
6) No holidays, dates, company names, or historical events.
7) Timeless (not tied to current events or trends).
8) Pick exactly ONE theme from this list and commit fully:
9) Vary perspective, wording, imagery, and scenario across calls.
10) Unique, not generic or cliche.
11) No repetition of previous questions.
12) No personal pronouns like "you" or "your".
13) No "what if" or "imagine" scenarios.
`;

export const promptsQuestionPrompt = `Generate the question now. Output only the question.
Do not include any additional text or formatting, and do not mention that you were prompted.`;

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
