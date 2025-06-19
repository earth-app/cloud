export const activityImagePrompt = (activity: string, description: string): string => {
    return `Create a sticker-ready illustration that represents "${activity}". The image should be clean, friendly, and recognizable-perfect as a sticker or app icon.

**Style & Aesthetic**
- Flat or minimally shaded with bold outlines, simplified shapes, and a vector-like look.
- Use 3-5 bright, cheerful colors. Flat fills preferred; subtle gradients okay.
- Match mood to the activity (calm = soft tones, energy = dynamic shapes), and prioritize bold, clean, simple, yet engaging visuals.
- Keep it playful and readable at small sizes. Add a white sticker border (with optional soft shadow).
- Use a transparent or white background.

**Composition**
- Center the main icon with balanced spacing. Avoid clutter.
- Focus on one clear symbol or character that expresses the idea of "${activity}".
- Do not include text or typography in the image.

**Concept & Symbolism**
- Choose a universal metaphor according to the description.
- Avoid literal or complex scenes. Keep it abstract, simple, and culturally neutral.
- Use shapes and symbols that evoke the essence of "${activity}" without being too specific or detailed.

Here is a description of "${activity}": '${description}'
Use this to inspire the visual elements and ensure the image captures the essence of the activity in a fun, engaging way.`
}

export const activityDescriptionSystemMessage = `
You are an expert in any given activity. 
You must provide a paragraph briefly explaining the activity in a concise, engaging manner. 
The description should be informative and educational but also lighthearted and fun. 
Your goal is to make the activity sound appealing and accessible to a wide audience, including those who may not be familiar with it. 
Use simple language, avoid jargon, and keep the tone upbeat and friendly. 
Do not use any emojis or special characters in your response. 
The description should be no longer than 250 words and should follow the provided guidelines closely. 
Present your answer in a single paragraph without any additional formatting or bullet points.
`

export const activityDescriptionPrompt = (activity: string): string => {
    return `Write a concise, engaging description (max 100 words and 500 characters) explaining what "${activity}" is. The tone should be informative and educational but also lighthearted and fun. Follow these guidelines:

1. **Opening Hook (1-2 sentences)**  
   - Start with a playful or intriguing sentence that quickly defines or frames the activity.  
   - Example: "Ever wondered why people love ${activity}? It's more than just a pastime-it's..."

2. **Core Explanation (2-3 short paragraphs)**  
   - **Definition & Essence**: Clearly state what ${activity} involves. Use simple language so anyone can understand.  
   - **How It Works / What You Do**: Summarize the basic steps or typical elements (e.g., "To get started, you need," "Participants usually").  
   - **Benefits & Appeal**: Highlight why people enjoy it-physical, mental, social, or creative perks. Keep it upbeat (e.g., "Besides being a great way to," "It's perfect for those who").

3. **Fun Fact or Twist (optional, 1 sentence)**  
   - Include a light trivia or surprising tidbit about ${activity}.  

4. **Friendly Invitation (1 sentence)**  
   - Encourage readers to try or learn more: "Whether you're a beginner or curious explorer, ${activity} offers."

5. **Constraints & Style**  
   - **Word limit**: Ensure the entire description is <= 100 words or 500 characters.  
   - **Readability**: Use short sentences or bullet-like flow; avoid jargon. If using a term, briefly explain it.  
   - **Tone**: Keep it upbeat, warm, and approachable, as if explaining to a friend. A touch of humor is fine but don't distract from clarity.

Ensure grammatical correctness and no special characters or emojis at all times. Do not use any formatting like ending prompts, bullet points or numbered lists. 
Present your answer in a single paragraph without any additional formatting, and make sure it flows naturally.`
}