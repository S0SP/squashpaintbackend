const fs = require('fs');

const API_KEY = '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';
const styleInstruction = 'Aesthetic: Classic animation line-art. Use bold, thick, expressive contours, friendly features, and highly simplified, massive flat regions.';
const baseSystemPrompt = `You are the master prompt engineer for a premium children's color-by-number application. Your sole purpose is to take short, simple ideas from children and expand them into highly descriptive visual prompts tailored specifically for a text-to-image generation model.

You must strictly obey the following foundational layout rules:
1. **Subject Focus:** The primary subject must be centrally framed, large, and clearly defined.
2. **Closed Vector Regions:** Ensure all background and foreground elements form clear, distinct, closed boundaries so they can be easily mapped for coloring. No chaotic scribbles.
3. **No Slop:** Strictly prohibit text, signatures, photorealistic rendering gradients, or overlapping structural artifacts.

CRITICAL STYLE CONSTRAINT: You must strictly apply the following structural aesthetic rules:
${styleInstruction}

MANDATORY APPEND: You must append this exact string to the very end of your final response:
"clean bold black outlines, minimalist, pure white background, no shading, strict color-by-number template style."

CRITICAL LIMIT: Your entire response must be UNDER 700 characters. Keep descriptions concise and focused.`;

async function run() {
    try {
        console.log('1. Expanding prompt via NVIDIA LLM...');
        const llmRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
            body: JSON.stringify({
                model: 'meta/llama-3.3-70b-instruct',
                messages: [{ role: 'system', content: baseSystemPrompt }, { role: 'user', content: 'cat on couch' }],
                temperature: 0.1, max_tokens: 180
            })
        });
        const llmData = await llmRes.json();
        let expandedPrompt = llmData.choices[0].message.content;
        if (expandedPrompt.length > 800) {
            const suffix = ' clean bold black outlines, minimalist, pure white background, no shading, strict color-by-number template style.';
            expandedPrompt = expandedPrompt.substring(0, 800 - suffix.length) + suffix;
        }
        console.log('Expanded prompt:', expandedPrompt);

        console.log('2. Generating image via FLUX...');
        const fluxRes = await fetch('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ prompt: expandedPrompt })
        });
        const fluxData = await fluxRes.json();
        const b64 = fluxData.artifacts[0].base64;
        fs.writeFileSync('C:/Users/sumit/.gemini/antigravity-ide/brain/9a521ed0-edee-4ec6-9ba2-9dd1e6c89682/cat_couch.png', Buffer.from(b64, 'base64'));
        console.log('Image saved successfully!');
    } catch(e) { console.error(e); }
}
run();
