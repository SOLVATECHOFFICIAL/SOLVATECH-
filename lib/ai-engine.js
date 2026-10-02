import axios from "axios";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger.js";
import {
  DEFAULT_QUIZ_BANK,
  DEFAULT_RIDDLES,
  DEFAULT_SCRAMBLE_WORDS,
  getAIConversationHistory,
  getDeepMemoryFacts,
  recordAIConversationTurn,
  recordDeepMemoryFact,
} from "./chat-memory.js";

const GEMINI_TEXT_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

let cachedClient = null;
let cachedKey = null;
let geminiBlockedUntil = 0;

const DIRECT_GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
];

function getBuiltInGroqToken() {
  return (process.env.GROQ_API_KEY || "").trim();
}

// Verified, live non-ZeroGPU and fallback Gradio LLM endpoints
const LIVE_GROQ_LLM_SPACES = [
  {
    host: "https://dexwel25-icbmd-chatbot.hf.space",
    endpoint: "/chat_fn",
    buildArgs: (prompt) => [prompt],
  },
  {
    host: "https://ishan2204-groq-ai-chatbot-2026.hf.space",
    endpoint: "/chatbot",
    buildArgs: (prompt) => [prompt],
  },
  {
    host: "https://chaithu123-chatbot-groq-langchain.hf.space",
    endpoint: "/get_text_response",
    buildArgs: (prompt) => [prompt],
  },
];

function getConfiguredGeminiKey() {
  const key = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.GEMINI_KEY ||
    ""
  ).trim();
  if (!key) {
    return "";
  }
  return key;
}

export function getGenAIClient() {
  const apiKey = getConfiguredGeminiKey();
  if (apiKey) {
    if (!cachedClient || cachedKey !== apiKey) {
      cachedClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
      cachedKey = apiKey;
    }
    return cachedClient;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credsRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS.trim();
    if (credsRaw.startsWith("{")) {
      try {
        const credentials = JSON.parse(credsRaw);
        return new GoogleGenAI({
          googleAuthOptions: { credentials },
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        });
      } catch (err) {
        logger.warn("Could not parse GOOGLE_APPLICATION_CREDENTIALS JSON", err.message);
      }
    } else {
      return new GoogleGenAI({
        httpOptions: { headers: { "User-Agent": "aistudio-build" } },
      });
    }
  }

  return null;
}

/**
 * Validates that an LLM response is clean English text and not an internal error / 401 message.
 */
function isValidCleanLLMResponse(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;

  const lower = trimmed.toLowerCase();
  if (
    lower.includes("invalid api key") ||
    lower.includes("error code: 401") ||
    lower.includes("error code: 403") ||
    lower.includes("error code: 429") ||
    lower.includes("error code: 500") ||
    lower.includes("hubo un error") ||
    lower.includes("organization has been restricted") ||
    lower.includes("organization_restricted") ||
    lower.includes("you have exceeded your") ||
    lower.includes("rate limit reached") ||
    lower.startsWith("error:")
  ) {
    return false;
  }
  return true;
}

/**
 * Calls a Gradio 5 space over HTTP and parses its `event: complete` output.
 */
async function callGradioSpace(host, endpoint, dataArgs, timeoutMs = 8000) {
  try {
    const startRes = await axios.post(
      `${host}/gradio_api/call${endpoint}`,
      { data: dataArgs },
      {
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
        timeout: 4000,
      }
    );
    const eventId = startRes.data?.event_id;
    if (!eventId) return null;

    const streamRes = await axios.get(`${host}/gradio_api/call${endpoint}/${eventId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: timeoutMs,
      responseType: "text",
    });

    const rawText = String(streamRes.data || "");
    const lines = rawText.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("data:")) {
        const jsonPart = line.slice(5).trim();
        if (!jsonPart || jsonPart === "null") continue;
        try {
          const parsed = JSON.parse(jsonPart);
          if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].trim()) {
            const textOut = parsed[0].trim();
            if (isValidCleanLLMResponse(textOut)) {
              return textOut;
            }
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

/**
 * Calls live LLM providers (Gemini -> Verified Groq Llama-3.3-70B -> Pollinations)
 * with strict error filtering so broken community messages never reach the user.
 */
export async function tryGeminiGenerate({
  contents,
  systemInstruction = "",
  responseMimeType = undefined,
  allowExternalFallback = true,
}) {
  // 1. Try @google/genai if authorized and unblocked
  const ai = getGenAIClient();
  if (ai && Date.now() >= geminiBlockedUntil) {
    for (const model of GEMINI_TEXT_MODELS) {
      try {
        const config = {
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(responseMimeType ? { responseMimeType } : {}),
        };
        const response = await ai.models.generateContent({
          model,
          contents,
          ...(Object.keys(config).length > 0 ? { config } : {}),
        });
        const out = (response.text || "").trim();
        if (isValidCleanLLMResponse(out)) return out;
      } catch (err) {
        const msg = String(err?.message || err);
        if (msg.includes("403") || msg.includes("PERMISSION_DENIED") || msg.includes("denied access")) {
          geminiBlockedUntil = Date.now() + 5 * 60 * 1000;
          break;
        }
      }
    }
  }

  if (!allowExternalFallback) {
    return null;
  }

  // Extract plain text prompt from contents
  let textPrompt = "";
  let hasInlineImage = false;
  if (typeof contents === "string") {
    textPrompt = contents;
  } else if (Array.isArray(contents)) {
    const textParts = [];
    for (const item of contents) {
      if (typeof item === "string") textParts.push(item);
      else if (item?.text) textParts.push(item.text);
      else if (item?.inlineData) hasInlineImage = true;
    }
    textPrompt = textParts.join("\n\n");
  } else if (contents?.parts && Array.isArray(contents.parts)) {
    for (const part of contents.parts) {
      if (part?.text) textPrompt += (textPrompt ? "\n\n" : "") + part.text;
      if (part?.inlineData) hasInlineImage = true;
    }
  }

  if (!textPrompt || hasInlineImage) {
    return null;
  }

  // 2. Try ultra-fast direct Groq OpenAI-compatible inference (~200ms, 120B flagship model)
  const groqToken = getBuiltInGroqToken();
  if (groqToken) {
    const messages = [];
    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }
    messages.push({ role: "user", content: textPrompt });

    for (const model of DIRECT_GROQ_MODELS) {
      try {
        const res = await axios.post(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            model,
            messages,
            temperature: 0.65,
            max_tokens: 900,
          },
          {
            headers: {
              Authorization: `Bearer ${groqToken}`,
              "Content-Type": "application/json",
            },
            timeout: 7000,
          }
        );
        let rawContent = String(res.data?.choices?.[0]?.message?.content || "").trim();
        // Strip <think>...</think> blocks if present from reasoning models
        rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        if (isValidCleanLLMResponse(rawContent)) {
          return rawContent;
        }
      } catch {}
    }
  }

  const combinedPrompt = systemInstruction
    ? `${systemInstruction}\n\n${textPrompt}`
    : textPrompt;

  // 3. Try verified non-ZeroGPU & Gradio LLM endpoints
  for (const space of LIVE_GROQ_LLM_SPACES) {
    try {
      const out = await callGradioSpace(
        space.host,
        space.endpoint,
        space.buildArgs(combinedPrompt),
        8000
      );
      if (out && isValidCleanLLMResponse(out)) return out;
    } catch {}
  }

  // 4. Try Pollinations text endpoint
  try {
    const pollRes = await axios.get(
      `https://text.pollinations.ai/${encodeURIComponent(combinedPrompt.slice(0, 1000))}`,
      { timeout: 6000 }
    );
    if (typeof pollRes.data === "string" && isValidCleanLLMResponse(pollRes.data)) {
      return pollRes.data.trim();
    }
  } catch {}

  return null;
}

/**
 * Helper to strictly validate and convert an image buffer to clean JPEG.
 * Discards XML error responses, HTML error pages, and invalid binary streams.
 */
async function validateAndConvertImageBuffer(rawBuf, targetWidth = 1024) {
  if (!rawBuf || !Buffer.isBuffer(rawBuf) || rawBuf.length < 1000) return null;

  // Reject XML / HTML error strings
  const prefixStr = rawBuf.slice(0, 100).toString("utf8").trim();
  if (
    prefixStr.startsWith("<") ||
    prefixStr.includes("<Error>") ||
    prefixStr.includes("<Code>") ||
    prefixStr.includes("PublicAccessNotPermitted") ||
    prefixStr.includes("<!DOCTYPE") ||
    prefixStr.includes("<html>")
  ) {
    return null;
  }

  try {
    const meta = await sharp(rawBuf).metadata();
    if (!meta || !meta.width || !meta.height) return null;

    let pipeline = sharp(rawBuf).rotate();
    if (meta.width > targetWidth || meta.height > targetWidth) {
      pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: true });
    }
    const jpeg = await pipeline.jpeg({ quality: 92 }).toBuffer();
    return jpeg;
  } catch {
    return null;
  }
}

/**
 * Creates a high-definition typographic graphic banner when the user requests text in color as picture.
 */
export async function generateColoredTextGraphic(rawPrompt = "", explicitText = "", explicitColor = "") {
  const clean = String(rawPrompt || "").trim();
  const colorSource = `${explicitColor || ""} ${clean}`.toLowerCase();

  // Extract color
  let chosenColor = "#38BDF8";
  let bgGradient1 = "#070B14";
  let bgGradient2 = "#162238";

  const COLOR_PALETTE = {
    red: { fg: "#EF4444", bg1: "#1A0505", bg2: "#3B0707" },
    crimson: { fg: "#F43F5E", bg1: "#1F040A", bg2: "#4C0519" },
    blue: { fg: "#38BDF8", bg1: "#031529", bg2: "#0C4A6E" },
    cyan: { fg: "#06B6D4", bg1: "#022329", bg2: "#164E63" },
    green: { fg: "#10B981", bg1: "#022C22", bg2: "#064E3B" },
    emerald: { fg: "#34D399", bg1: "#022C22", bg2: "#065F46" },
    lime: { fg: "#84CC16", bg1: "#142603", bg2: "#365314" },
    gold: { fg: "#FBBF24", bg1: "#241702", bg2: "#451A03" },
    yellow: { fg: "#FACC15", bg1: "#231B02", bg2: "#422006" },
    purple: { fg: "#C084FC", bg1: "#1E0B36", bg2: "#3B0764" },
    violet: { fg: "#A78BFA", bg1: "#170D36", bg2: "#2E1065" },
    pink: { fg: "#F472B6", bg1: "#30081C", bg2: "#500724" },
    magenta: { fg: "#E879F9", bg1: "#2E0735", bg2: "#4A044E" },
    orange: { fg: "#FB923C", bg1: "#2A0E04", bg2: "#431407" },
    teal: { fg: "#2DD4BF", bg1: "#042F2E", bg2: "#134E4A" },
    silver: { fg: "#E2E8F0", bg1: "#0F172A", bg2: "#334155" },
    white: { fg: "#FFFFFF", bg1: "#090D16", bg2: "#1E293B" },
    black: { fg: "#111827", bg1: "#F8FAFC", bg2: "#E2E8F0" },
    neon: { fg: "#00FF9D", bg1: "#04120C", bg2: "#062E1E" },
  };

  for (const [colorName, theme] of Object.entries(COLOR_PALETTE)) {
    if (new RegExp(`\\b${colorName}\\b`, "i").test(colorSource)) {
      chosenColor = theme.fg;
      bgGradient1 = theme.bg1;
      bgGradient2 = theme.bg2;
      break;
    }
  }

  // Extract the text to display
  let textToDisplay = String(explicitText || "").trim();
  if (!textToDisplay) {
    const quotedMatch = clean.match(/["'“”‘’]([^"'“”‘’]{1,160})["'“”‘’]/);
    if (quotedMatch) {
      textToDisplay = quotedMatch[1].trim();
    } else {
      textToDisplay = clean
        .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:put|make|create|write|render|give|send|show|generate|design|turn)\s+(?:me\s+)?(?:a\s+|an\s+|this\s+|the\s+)?(?:text|words?|message|name)?\s*/i, "")
        .replace(/\b(?:in|with|using)\s+(?:a\s+)?(?:red|crimson|blue|cyan|green|emerald|lime|gold|yellow|purple|violet|pink|magenta|orange|teal|silver|white|black|neon)?\s*(?:colour|color)?\s*(?:as|into|on|like|in)?\s*(?:a\s+|an\s+)?(?:pic|picture|image|photo|graphic|banner|card|wallpaper)?\s*$/i, "")
        .replace(/\b(?:as|into|like)\s+(?:a\s+|an\s+)?(?:colour|color|coloured|colored)?\s*(?:pic|picture|image|photo|graphic|banner|card)\s*$/i, "")
        .replace(/\b(?:in\s+colour|in\s+color)\s*(?:as\s+(?:a\s+)?(?:pic|picture|image|photo))?\s*$/i, "")
        .replace(/^[:"'`\s]+|[:"'`\s]+$/g, "")
        .trim();
    }
  }

  if (!textToDisplay || /^(?:a\s+text|text|some\s+text|words|pic|picture|image)$/i.test(textToDisplay)) {
    textToDisplay = "SOLVATECH META AI";
  }

  // Wrap text into multiple lines
  const words = textToDisplay.split(/\s+/);
  const lines = [];
  let currentLine = "";
  for (const w of words) {
    if ((currentLine + " " + w).trim().length <= 20) {
      currentLine = (currentLine + " " + w).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = w;
    }
  }
  if (currentLine) lines.push(currentLine);

  const fontSize = lines.length > 4 ? 44 : lines.length > 2 ? 56 : lines.length > 1 ? 68 : 82;
  const startY = 512 - ((lines.length - 1) * (fontSize * 1.32)) / 2 + fontSize * 0.35;

  const tspans = lines
    .map((line, idx) => `<tspan x="512" y="${Math.round(startY + idx * fontSize * 1.32)}">${escapeXml(line)}</tspan>`)
    .join("\n");

  const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bgGradient1}"/>
      <stop offset="100%" stop-color="${bgGradient2}"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="12" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="36" fill="url(#bgGrad)" />
  <rect x="36" y="36" width="952" height="952" rx="28" fill="none" stroke="${chosenColor}" stroke-width="4" stroke-opacity="0.35" />
  <text text-anchor="middle" fill="${chosenColor}" font-family="system-ui, -apple-system, Roboto, 'Segoe UI', Arial, sans-serif" font-size="${fontSize}" font-weight="800" filter="url(#glow)">
    ${tspans}
  </text>
</svg>`;

  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  return {
    buffer,
    caption: `🎨 *${textToDisplay}*`,
  };
}

function escapeXml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates or fetches a high-resolution image for Meta AI image requests.
 * Guarantees a real binary image buffer (never an XML error or broken URL).
 */
export async function generateMetaImage(promptText = "") {
  // A. Check if the user asked to render text in color as picture
  if (
    /\b(?:put|make|create|write|render|turn)\s+.*(?:text|word|name).*(?:colour|color|pic|picture|image)\b/i.test(promptText) ||
    /\btext\s+in\s+(?:colour|color|red|blue|green|gold|yellow|purple|pink|orange|cyan|white|black|emerald|violet|crimson|neon|teal)/i.test(promptText) ||
    /\bin\s+(?:red|blue|green|gold|yellow|purple|pink|orange|cyan|white|emerald|violet|crimson|neon|teal)\s+(?:colour|color)?\s*as\s+(?:a\s+)?(?:pic|picture|image|photo)\b/i.test(promptText)
  ) {
    return await generateColoredTextGraphic(promptText);
  }

  const cleanPrompt = String(promptText || "")
    .replace(
      /^(?:please\s+)?(?:i\s+(?:asked|ask|want|need)\s+(?:for\s+)?|can\s+(?:you|i)\s+(?:get|have|see)\s+|(?:give|send|show|generate|create|make|draw|get|find|fetch)\s+(?:me\s+)?)+(?:a\s+|an\s+|some\s+|the\s+)?(?:fine\s+|nice\s+|cool\s+|beautiful\s+|good\s+|real\s+|clear\s+|hd\s+)?(?:picture|pic|poc|pik|pix|photo|foto|image|portrait|drawing|art|wallpaper)s?\s*(?:of\s+|for\s+)?/i,
      ""
    )
    .replace(/\b(?:pic|picture|photo|image)\s+of\s+/i, "")
    .replace(/\s+(?:pic|picture|photo|image)$/i, "")
    .trim() || promptText.trim();

  // 1. Try Gemini Image generation if authorized
  const ai = getGenAIClient();
  if (ai && Date.now() >= geminiBlockedUntil) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: {
          parts: [{ text: `High quality photorealistic image: ${cleanPrompt}` }],
        },
      });
      const parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const buf = Buffer.from(part.inlineData.data, "base64");
          const validated = await validateAndConvertImageBuffer(buf);
          if (validated) {
            return {
              buffer: validated,
              caption: `🖼️ *${cleanPrompt}*`,
            };
          }
        }
      }
    } catch {}
  }

  // 2. Try High-Speed Real Photo & AI Image Engines (Bing Dynamic Image Proxy + Pollinations FLUX)
  const randSeed = Math.floor(Math.random() * 999999);
  const directImageUrls = [
    `https://tse2.mm.bing.net/th?q=${encodeURIComponent(`${cleanPrompt} high resolution photo`)}&w=1024&h=1024&c=7&rs=1&p=0`,
    `https://tse1.mm.bing.net/th?q=${encodeURIComponent(cleanPrompt)}&w=1024&h=768&c=7&rs=1&p=0`,
    `https://image.pollinations.ai/prompt/${encodeURIComponent(`${cleanPrompt}, photorealistic, high detail, 8k`)}?model=flux&width=1024&height=1024&seed=${randSeed}&nologo=true`,
    `https://tse3.mm.bing.net/th?q=${encodeURIComponent(`${cleanPrompt} photography`)}&w=900&h=900&c=7&rs=1&p=0`,
  ];

  for (const imgUrl of directImageUrls) {
    try {
      const res = await axios.get(imgUrl, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        timeout: 8500,
      });
      const validated = await validateAndConvertImageBuffer(Buffer.from(res.data));
      if (validated) {
        return {
          buffer: validated,
          caption: `🖼️ *${cleanPrompt}*`,
        };
      }
    } catch {}
  }

  // 3. Search Lexica AI Art Gallery API
  try {
    const lexicaRes = await axios.get("https://lexica.art/api/v1/search", {
      params: { q: cleanPrompt },
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 6000,
    });
    const images = Array.isArray(lexicaRes.data?.images) ? lexicaRes.data.images : [];
    if (images.length > 0) {
      const candidate = images[Math.floor(Math.random() * Math.min(images.length, 6))];
      const directUrl = candidate?.src || candidate?.srcSmall;
      if (directUrl) {
        const imgRes = await axios.get(directUrl, {
          responseType: "arraybuffer",
          headers: { "User-Agent": "Mozilla/5.0" },
          timeout: 6000,
        });
        const validated = await validateAndConvertImageBuffer(Buffer.from(imgRes.data));
        if (validated) {
          return {
            buffer: validated,
            caption: `🎨 *${cleanPrompt}*`,
          };
        }
      }
    }
  } catch {}

  // 4. Search Wikimedia Commons with strict binary validation
  try {
    const wikiRes = await axios.get("https://commons.wikimedia.org/w/api.php", {
      params: {
        action: "query",
        generator: "search",
        gsrsearch: `${cleanPrompt} filetype:bitmap`,
        gsrlimit: 6,
        prop: "imageinfo",
        iiprop: "url",
        iiurlwidth: 900,
        format: "json",
      },
      headers: { "User-Agent": "SolvaTechBot/2.0 (https://solvatech.ai)" },
      timeout: 6000,
    });
    const pages = Object.values(wikiRes.data?.query?.pages || {});
    for (const p of pages) {
      const u = p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url;
      if (!u) continue;
      try {
        const imgRes = await axios.get(u, {
          responseType: "arraybuffer",
          headers: { "User-Agent": "SolvaTechBot/2.0 (https://solvatech.ai)" },
          timeout: 6000,
        });
        const validated = await validateAndConvertImageBuffer(Buffer.from(imgRes.data));
        if (validated) {
          return {
            buffer: validated,
            caption: `🖼️ *${cleanPrompt}*`,
          };
        }
      } catch {}
    }
  } catch {}

  // 5. Fallback to Colored Text Graphic if all network engines are unreachable
  return await generateColoredTextGraphic(cleanPrompt, cleanPrompt, "blue");
}

/**
 * Extracts verbatim text from an image buffer using Gemini Vision or local Tesseract OCR.
 */
export async function extractTextFromImage(rawBuffer) {
  if (!rawBuffer || !Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
    throw new Error("Empty or invalid image buffer.");
  }

  let jpegBuffer = rawBuffer;
  try {
    jpegBuffer = await sharp(rawBuffer)
      .rotate()
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (sharpErr) {
    logger.debug?.("Sharp JPEG normalization notice:", sharpErr.message);
    jpegBuffer = rawBuffer;
  }

  // 1. Try Gemini Vision OCR if available
  const geminiOcr = await tryGeminiGenerate({
    contents: [
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: jpegBuffer.toString("base64"),
        },
      },
      {
        text: "Extract and transcribe all visible text from this image VERBATIM without translating, summarizing, correcting, or adding commentary. Return ONLY the exact transcribed text as it appears in the image. If there is no visible text in the image, reply with: [NO TEXT DETECTED IN IMAGE]",
      },
    ],
    allowExternalFallback: false,
  });

  if (geminiOcr) {
    if (geminiOcr === "[NO TEXT DETECTED IN IMAGE]") {
      return "";
    }
    return geminiOcr.trim();
  }

  // 2. Local Tesseract.js OCR fallback
  let preprocessedBuffer = jpegBuffer;
  try {
    const metadata = await sharp(rawBuffer).metadata();
    const targetWidth = metadata.width && metadata.width < 1000 ? metadata.width * 2 : undefined;
    let pipeline = sharp(rawBuffer).rotate().grayscale().normalize().sharpen();
    if (targetWidth) {
      pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: false });
    }
    preprocessedBuffer = await pipeline.png().toBuffer();
  } catch {
    preprocessedBuffer = jpegBuffer;
  }

  try {
    const { default: Tesseract } = await import("tesseract.js");
    const result = await Tesseract.recognize(preprocessedBuffer, "eng");
    const text = String(result?.data?.text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text;
  } catch (tessErr) {
    logger.error("Tesseract OCR fallback error", tessErr.message);
    throw new Error("Could not extract text from the image.");
  }
}

/**
 * Explains or analyzes an image buffer.
 */
export async function explainImageBuffer(rawBuffer, userPrompt = "Explain this image clearly.") {
  if (!rawBuffer || !Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
    throw new Error("Could not download the image to analyze.");
  }

  let jpegBuffer = rawBuffer;
  let metaInfo = null;
  try {
    metaInfo = await sharp(rawBuffer).metadata();
    jpegBuffer = await sharp(rawBuffer).rotate().jpeg({ quality: 90 }).toBuffer();
  } catch {}

  const promptText =
    userPrompt && userPrompt.trim()
      ? userPrompt.trim()
      : "Explain this image in detail, describing what is shown, any visible text, and key takeaways.";

  // 1. Try Gemini Vision
  const geminiVision = await tryGeminiGenerate({
    contents: [
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: jpegBuffer.toString("base64"),
        },
      },
      {
        text: promptText,
      },
    ],
    systemInstruction:
      "You are SOLVATECH Meta AI inside WhatsApp. Provide a clear, accurate, well-structured explanation of the image.",
    allowExternalFallback: false,
  });

  if (geminiVision) {
    return geminiVision;
  }

  // 2. Extract visible text via OCR + pass to LLM
  let ocrText = "";
  try {
    ocrText = await extractTextFromImage(rawBuffer);
  } catch {}

  const dimensions =
    metaInfo?.width && metaInfo?.height ? `${metaInfo.width}×${metaInfo.height}px` : "Standard image";
  const format = (metaInfo?.format || "image").toUpperCase();

  if (ocrText) {
    const llmExplanation = await tryGeminiGenerate({
      contents: `The user sent an image (${format}, ${dimensions}) and asked: "${promptText}".\n\nHere is the text extracted from the image via OCR:\n"""\n${ocrText}\n"""\n\nPlease answer the user's request and explain the content clearly.`,
      systemInstruction: "You are SOLVATECH Meta AI. Analyze the extracted image text and answer the user's question directly and helpfully.",
    });

    if (llmExplanation) {
      return llmExplanation;
    }

    return [
      "🖼️ *IMAGE ANALYSIS & EXPLANATION*",
      "────────────────────────────",
      `• *Format & Resolution:* ${format} (${dimensions})`,
      "",
      "📖 *Visible Text in Image:*",
      ocrText,
    ].join("\n");
  }

  return [
    "🖼️ *IMAGE ANALYSIS*",
    "────────────────────────────",
    `• *Format:* ${format}`,
    `• *Dimensions:* ${dimensions}`,
    `• *Color Space:* ${metaInfo?.space || "sRGB"}`,
    `• *Visible Text:* None detected`,
    "",
    "ℹ️ _This is a visual graphic/photo with no embedded text._",
  ].join("\n");
}

/**
 * Summarizes actual available group/chat messages honestly.
 */
export async function summarizeAvailableMessages(messages, userQuery = "") {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "I can only summarize the messages currently available to me. There are no recorded chat messages in my current session history for this conversation yet.";
  }

  const formattedTranscript = messages
    .map((m) => {
      const timeStr = new Date(m.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const speaker = m.pushName
        ? `${m.pushName} (@${m.senderNumber || "user"})`
        : `@${m.senderNumber || "user"}`;
      const mediaTag = m.mediaType ? `[${m.mediaType.toUpperCase()}] ` : "";
      return `[${timeStr}] ${speaker}: ${mediaTag}${m.text || ""}`;
    })
    .join("\n");

  const aiSummary = await tryGeminiGenerate({
    contents: [
      {
        text: [
          `User request: "${userQuery || "Summarize the conversation"}"`,
          `Available chat history (${messages.length} messages):`,
          formattedTranscript,
        ].join("\n\n"),
      },
    ],
    systemInstruction:
      "You are SOLVATECH Meta AI. Use ONLY the provided chat transcript. Do NOT invent conversations or pretend to have access to messages that are not in the transcript. Summarize the key topics, who said what, and answer the user's specific question about the conversation clearly and concisely.",
  });

  if (aiSummary) {
    return [
      `📋 *CHAT SUMMARY (${messages.length} available message${messages.length === 1 ? "" : "s"})*`,
      "────────────────────────────",
      aiSummary,
    ].join("\n");
  }

  // Deterministic local conversation analyzer
  const queryLower = String(userQuery || "").toLowerCase();

  const searchMatch =
    queryLower.match(/(?:mentioned|talking about|talked about|discussed|said about|find where.*mentioned)\s+(.+?)$/i) ||
    queryLower.match(/about\s+the\s+(.+?)$/i);

  if (searchMatch) {
    const rawTopic = searchMatch[1]
      .replace(/[?.!]+$/g, "")
      .replace(/^(the|a|an)\s+/i, "")
      .trim();
    const keywords = rawTopic
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    const matchingMsgs = messages.filter((m) => {
      const hay = `${m.text || ""}`.toLowerCase();
      return keywords.some((kw) => hay.includes(kw));
    });

    if (matchingMsgs.length > 0) {
      const matchLines = matchingMsgs.slice(-10).map((m) => {
        const timeStr = new Date(m.timestamp).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const speaker = m.pushName ? `${m.pushName} (@${m.senderNumber})` : `@${m.senderNumber}`;
        return `• *[${timeStr}] ${speaker}:* "${m.text}"`;
      });

      return [
        `🔎 *CONVERSATION SEARCH: "${rawTopic}"*`,
        `Found *${matchingMsgs.length}* matching message${matchingMsgs.length === 1 ? "" : "s"} in the ${messages.length} available messages:`,
        "",
        ...matchLines,
      ].join("\n");
    } else {
      return `🔎 I checked the *${messages.length}* currently available message${messages.length === 1 ? "" : "s"} in this chat, and no one mentioned *"${rawTopic}"*. (I can only search the messages currently available to me.)`;
    }
  }

  const bySpeaker = new Map();
  for (const m of messages) {
    const key = m.senderNumber || m.senderJid || "unknown";
    const entry = bySpeaker.get(key) || {
      senderNumber: m.senderNumber,
      pushName: m.pushName || "",
      count: 0,
      samples: [],
    };
    entry.count += 1;
    if (m.pushName && !entry.pushName) entry.pushName = m.pushName;
    if (m.text && entry.samples.length < 3) {
      entry.samples.push(m.text.length > 90 ? `${m.text.slice(0, 87)}...` : m.text);
    }
    bySpeaker.set(key, entry);
  }

  const speakersSorted = Array.from(bySpeaker.values()).sort((a, b) => b.count - a.count);
  const topContributors = speakersSorted.slice(0, 6).map((s) => {
    const label = s.pushName ? `${s.pushName} (@${s.senderNumber})` : `@${s.senderNumber}`;
    return `• *${label}* (${s.count} msg${s.count === 1 ? "" : "s"})${s.samples.length ? `: _"${s.samples[s.samples.length - 1]}"_` : ""}`;
  });

  const recentHighlights = messages
    .filter((m) => m.text)
    .slice(-8)
    .map((m) => {
      const timeStr = new Date(m.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const label = m.pushName || `@${m.senderNumber}`;
      const snippet = m.text.length > 100 ? `${m.text.slice(0, 97)}...` : m.text;
      return `• [${timeStr}] *${label}:* ${snippet}`;
    });

  return [
    `📋 *CHAT SUMMARY (${messages.length} available message${messages.length === 1 ? "" : "s"})*`,
    "────────────────────────────",
    `👥 *Active Participants (${bySpeaker.size}):*`,
    ...topContributors,
    "",
    "💬 *Recent Key Messages:*",
    ...(recentHighlights.length ? recentHighlights : ["• _(Media messages only)_"]),
  ].join("\n");
}

const JOKES_LIST = [
  "Why do programmers prefer dark mode?\nBecause light attracts bugs! 🐛💻",
  "Why did the developer go broke?\nBecause he used up all his cache! 💸",
  "How many programmers does it take to change a light bulb?\nNone — that's a hardware problem! 💡",
  "Why did the smartphone go to school?\nBecause it wanted to be a little smarter! 📱🎓",
  "I told my Wi-Fi we were having connection issues.\nNow it won't even talk to me without a password! 📶😂",
  "Why do Java developers wear glasses?\nBecause they can't C#! 👓",
  "What do you call a group chat where everyone actually replies on time?\nScience fiction! 🚀😂",
];

const GREETINGS_MAP = {
  wassup: "Not much, just here and ready to help! What's up with you? 😊",
  "what's up": "All good on my end! How are you doing today?",
  whatsup: "Everything is running smooth! How can I help you?",
  "how far": "I dey fine well well! How you dey? What can I do for you today? 🙌",
  "how are you": "I'm doing great, thank you for asking! How are you doing?",
  "am good": "Glad to hear that! How can I assist you today? 😊",
  "i'm good": "Awesome! What would you like to explore or do next?",
  hello: "Hello there! How's your day going?",
  hi: "Hey! What can I do for you today?",
  hey: "Hey! What's on your mind?",
  yo: "Yo! How can I help you out today?",
  "good morning": "Good morning! ☀️ Wishing you a productive and wonderful day ahead! How can I help?",
  "good afternoon": "Good afternoon! Hope your day is going well! How can I assist?",
  "good evening": "Good evening! 🌙 How can I help you tonight?",
  thanks: "You're very welcome! Let me know if you need anything else! 🙌",
  "thank you": "My pleasure! Always happy to help! 😊",
};

/**
 * Generates a natural conversational reply
 * with multi-turn per-chat conversation history.
 */
export async function generateMetaConversationalReply(userPrompt, quotedText = "", options = {}) {
  const {
    userId = "default",
    chatId = "",
    senderName = "",
    chatContextSummary = "",
  } = options;
  const lower = String(userPrompt || "").toLowerCase().trim();

  // Instant casual greetings & replies if simple 1-2 word greeting
  if (!quotedText && GREETINGS_MAP[lower]) {
    const greetingReply = GREETINGS_MAP[lower];
    if (chatId) {
      recordAIConversationTurn(userId, chatId, userPrompt, greetingReply);
    }
    return greetingReply;
  }

  // Check if user explicitly asked to remember something
  if (/^(?:please\s+)?(?:remember\s+that|don'?t\s+forget\s+that|save\s+to\s+memory|memorize\s+that)\s+(.+)$/i.test(userPrompt.trim())) {
    const m = userPrompt.trim().match(/^(?:please\s+)?(?:remember\s+that|don'?t\s+forget\s+that|save\s+to\s+memory|memorize\s+that)\s+(.+)$/i);
    const fact = m[1].trim();
    if (chatId && fact) {
      recordDeepMemoryFact(userId, chatId, `${senderName ? `${senderName}: ` : ""}${fact}`, senderName || "User");
      const ack = `🧠 Got it! I've stored that in my permanent memory: _"${fact}"_`;
      recordAIConversationTurn(userId, chatId, userPrompt, ack, senderName);
      return ack;
    }
  }

  const priorTurns = chatId ? getAIConversationHistory(userId, chatId, 24) : [];
  const deepFacts = chatId ? getDeepMemoryFacts(userId, chatId) : [];

  const deepMemoryBlock =
    deepFacts.length > 0
      ? "Permanent Deep Memory Facts stored for this chat/group (always remember and use these facts):\n" +
        deepFacts.map((f, i) => `${i + 1}. ${f.fact} (by ${f.addedBy})`).join("\n") +
        "\n\n"
      : "";

  const historyTranscript =
    priorTurns.length > 0
      ? "Previous AI conversation turns in this chat (do not forget this context):\n" +
        priorTurns
          .map((t) => `${t.role === "user" ? `User${t.senderName ? ` (${t.senderName})` : ""}` : "Meta AI"}: ${t.content}`)
          .join("\n") +
        "\n\n"
      : "";

  const liveChatBlock = chatContextSummary
    ? `Live WhatsApp Chat Context & Participant Details:\n${chatContextSummary}\n\n`
    : "";

  const quotedContext = quotedText
    ? `Replied-to WhatsApp message:\n"""\n${quotedText}\n"""\n\n`
    : "";

  const fullInput = `${liveChatBlock}${deepMemoryBlock}${historyTranscript}${quotedContext}User${senderName ? ` (${senderName})` : ""}: ${userPrompt}`;

  const aiReply = await tryGeminiGenerate({
    contents: fullInput,
    systemInstruction: [
      "You are SOLVATECH Meta AI, an ultra-intelligent, warm, realistic, and deeply capable AI assistant inside WhatsApp.",
      "Rules for how you respond:",
      "1. Speak natural, clear, conversational English suited for WhatsApp (concise, well-formatted with *bold* where helpful, never robotic).",
      "2. Use your Permanent Deep Memory Facts, Previous Conversation Turns, and Live WhatsApp Chat Context so you remember who everyone is, what they like, and what was discussed.",
      "3. Be smart and inquisitive: if the user gives an incomplete request, ask a natural, specific follow-up question to confirm what they want.",
      "4. NEVER output fake image links, markdown image URLs, or blob storage URLs in text.",
    ].join("\n"),
  });

  if (aiReply) {
    // Strip any hallucinated broken image/storage URLs if an LLM ever outputs one
    const sanitizedReply = aiReply
      .replace(/!\[.*?\]\(https?:\/\/[^\s)]+\)/gi, "")
      .replace(/https?:\/\/[^\s]*blob\.core\.windows\.net[^\s]*/gi, "")
      .trim();
    if (chatId) {
      recordAIConversationTurn(userId, chatId, userPrompt, sanitizedReply || aiReply, senderName);
    }
    return sanitizedReply || aiReply;
  }

  // Joke fallback
  if (/\b(joke|funny|laugh|humor)\b/i.test(lower)) {
    const joke = JOKES_LIST[Math.floor(Math.random() * JOKES_LIST.length)];
    return `😄 *${joke}*`;
  }

  // Riddle fallback
  if (/\b(riddle|brain\s*teaser)\b/i.test(lower)) {
    const r = DEFAULT_RIDDLES[Math.floor(Math.random() * DEFAULT_RIDDLES.length)];
    return `🧩 *RIDDLE TIME*\n\n❝ *${r.riddle}* ❞\n\n💡 _Answer:_ || *${r.displayAnswer}* ||`;
  }

  // Math expression evaluation
  const mathCandidate = lower
    .replace(/^(what is|calculate|solve|compute|evaluate)\s+/i, "")
    .replace(/[?=]+$/g, "")
    .trim();
  if (/^[\d\s+\-*/().%^]+$/.test(mathCandidate) && /\d/.test(mathCandidate)) {
    try {
      const normalizedExpr = mathCandidate.replace(/\^/g, "**");
      const val = Function(`"use strict"; return (${normalizedExpr});`)();
      if (typeof val === "number" && Number.isFinite(val)) {
        return `🧮 *${mathCandidate} = ${val}*`;
      }
    } catch {}
  }

  // Natural conversational fallback without repetitive robotic phrasing
  const naturalFallback = quotedText
    ? `Got it! Regarding _"${quotedText.slice(0, 90)}${quotedText.length > 90 ? "..." : ""}"_ — what would you like me to do with it?`
    : `Got you! Tell me a little more or confirm what you'd like me to do, and I'll handle it right away.`;

  if (chatId) {
    recordAIConversationTurn(userId, chatId, userPrompt, naturalFallback);
  }
  return naturalFallback;
}

/**
 * Translates text using live LLM or Google Translate clients5.
 */
export async function translateContent(sourceText, targetLanguage = "English") {
  if (!sourceText || !String(sourceText).trim()) {
    return null;
  }

  const aiTranslation = await tryGeminiGenerate({
    contents: `Translate the following text into ${targetLanguage}. Provide ONLY the accurate translation (and brief pronunciation/notes if helpful):\n\n"""\n${sourceText}\n"""`,
    systemInstruction: "You are a precise multilingual translator for SOLVATECH Meta AI.",
  });

  if (aiTranslation) {
    return [
      `🌐 *TRANSLATION (${targetLanguage})*`,
      "────────────────────────────",
      aiTranslation,
    ].join("\n");
  }

  const langMap = {
    english: "en",
    en: "en",
    french: "fr",
    fr: "fr",
    spanish: "es",
    es: "es",
    german: "de",
    arabic: "ar",
    yoruba: "yo",
    igbo: "ig",
    hausa: "ha",
    portuguese: "pt",
    italian: "it",
    chinese: "zh-CN",
    japanese: "ja",
    korean: "ko",
    russian: "ru",
    hindi: "hi",
    swahili: "sw",
  };
  const tl = langMap[String(targetLanguage || "english").toLowerCase().trim()] || "en";

  try {
    const res = await axios.get("https://clients5.google.com/translate_a/t", {
      params: {
        client: "dict-chrome-ex",
        sl: "auto",
        tl,
        q: sourceText,
      },
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 6000,
    });
    const first = res.data?.[0];
    const translated = Array.isArray(first) ? first[0] : typeof first === "string" ? first : "";
    if (translated) {
      return [
        `🌐 *TRANSLATION (${targetLanguage})*`,
        "────────────────────────────",
        translated,
      ].join("\n");
    }
  } catch {}

  return [
    `🌐 *TRANSLATION (${targetLanguage})*`,
    "────────────────────────────",
    sourceText,
  ].join("\n");
}

/**
 * Generates or selects quiz questions.
 */
export async function buildQuizQuestions(topic = "", count = 5) {
  const aiJson = await tryGeminiGenerate({
    contents: `Create a ${count}-question multiple-choice trivia quiz${topic ? ` about "${topic}"` : " covering general knowledge, science, sports, and world facts"}. Return ONLY a valid JSON array of objects (no markdown fences) with properties: question (string), options (array of 4 strings starting with "A) ", "B) ", "C) ", "D) "), answerLetter ("A"|"B"|"C"|"D"), answerText (lowercase answer text), explanation (short string).`,
    responseMimeType: "application/json",
  });

  if (aiJson) {
    try {
      const cleaned = aiJson
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const startBracket = cleaned.indexOf("[");
      const endBracket = cleaned.lastIndexOf("]");
      const jsonSlice =
        startBracket !== -1 && endBracket !== -1
          ? cleaned.slice(startBracket, endBracket + 1)
          : cleaned;
      const parsed = JSON.parse(jsonSlice);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed[0].question &&
        Array.isArray(parsed[0].options)
      ) {
        return parsed.slice(0, count);
      }
    } catch {}
  }

  const copy = [...DEFAULT_QUIZ_BANK];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

export function pickRiddles(count = 3) {
  const copy = [...DEFAULT_RIDDLES];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

export function pickScrambleWords(count = 3) {
  const copy = [...DEFAULT_SCRAMBLE_WORDS];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}
