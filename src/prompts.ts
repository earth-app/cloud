import * as ocean from '@earth-app/ocean';

export const activityDescriptionSystemMessage = `
You are an expert in any given activity. 
You must provide a paragraph briefly explaining the activity in a concise, engaging manner. 
The description should be informative and educational but also lighthearted and fun. 
Your goal is to make the activity sound appealing and accessible to a wide audience, including those who may not be familiar with it. 
Use simple language, avoid jargon, and keep the tone upbeat and friendly. 
Do not use any emojis or special characters in your response. 
The description should be no longer than 100 words, 500 characters, or 160 tokens, and should follow the provided guidelines closely. 
Present your answer in a single paragraph without any additional formatting or bullet points.
`;

export const activityDescriptionPrompt = (activity: string): string => {
	return `Write a concise, engaging description, explaining what "${activity}" is. The tone should be informative and educational but also lighthearted and fun. Follow these guidelines:

1. **Opening Hook (1-2 sentences)**  
   - Start with a playful or intriguing sentence that quickly defines or frames the activity.  
   - Examples: 
       - "Ever wondered why people love ${activity}? It's more than just a pastime-it's..."
       - "Imagine a world where ${activity} is the norm, not the exception. Here's why it matters..."
       - "If you think ${activity} is just for experts, think again! It's actually a great way to...".

2. **Core Explanation (2-3 short paragraphs)**  
   - **Definition & Essence**: Clearly state what ${activity} involves. Use simple language so anyone can understand.  
   - **How It Works / What You Do**: Summarize the basic steps or typical elements (e.g., "To get started, you need," "Participants usually").  
   - **Benefits & Appeal**: Highlight why people enjoy it-physical, mental, social, or creative perks. Keep it upbeat (e.g., "Besides being a great way to," "It's perfect for those who").

3. **Fun Fact or Twist (optional, 1 sentence)**  
   - Include a light trivia or surprising tidbit about ${activity}.  

4. **Friendly Invitation (1 sentence)**  
   - Encourage readers to try or learn more: 
       - "Whether you're a beginner or curious explorer, ${activity} offers."
       - "Join the fun and discover why ${activity} is loved by so many!"

5. **Constraints & Style**  
   - **Word limit**: Ensure the entire description is <= 100 words or 500 characters.  
   - **Readability**: Use short sentences or bullet-like flow; avoid jargon. If using a term, briefly explain it.  
   - **Tone**: Keep it upbeat, warm, and approachable, as if explaining to a friend. A touch of humor is fine but don't distract from clarity.

Ensure grammatical correctness and no special characters or emojis at all times. Do not use any formatting like ending prompts, bullet points or numbered lists. 
Present your answer in a single paragraph without any additional formatting, and make sure it flows naturally.`;
};

export const activityTagsSystemMessage = `
You are given an activity and a fixed list of tags.
You must output up to 5 tags, exactly matching items in the tag list (case-sensitive lowercase), separated by commas, with no other output.
Limit your response to under 150 characters, as the list of tags is fixed and should not be modified.

The tags are: '${ocean.com.earthapp.activity.ActivityType.values()
	.map((t) => `"${t.name.toLowerCase()}"`)
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
