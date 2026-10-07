import { generateMetaConversationalReply } from "../lib/ai-engine.js";
import { getMessageText, getQuotedMessage } from "../lib/helpers.js";

export default async function ai({ message, text, args = [], reply, sock }) {
  const prompt = text || args.join(" ").trim();
  const quoted = getQuotedMessage(message, sock);
  const quotedText = quoted ? getMessageText(quoted) : "";

  if (!prompt && !quotedText) {
    return reply(
      "🤖 *SOLVATECH AI ASSISTANT*\n\n" +
      "Ask any question or reply to a message with *.ai*.\n" +
      "_Example: *.ai explain quantum computing in simple terms*_\n" +
      "_Example: *.ai write a professional apology email*_"
    );
  }

  try {
    const finalPrompt = prompt || "Please analyze and explain this message:";
    const aiResponse = await generateMetaConversationalReply(finalPrompt, quotedText);

    if (!aiResponse || !aiResponse.trim()) {
      return reply("🤖 *AI:* I could not generate a response at this moment. Please rephrase your question.");
    }

    await reply([
      "🤖 *SOLVATECH AI*",
      "────────────────────────────",
      aiResponse.trim(),
      "────────────────────────────",
    ].join("\n"));
  } catch (error) {
    await reply(`❌ AI error: ${error.message || "Failed to process AI request"}`);
  }
}
