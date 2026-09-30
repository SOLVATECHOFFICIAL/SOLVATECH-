import fs from "node:fs";
import path from "node:path";
import {
  extractParticipantNumber,
  getMessageContent,
  getMessageText,
  jidAliases,
  mediaTypeFromMessage,
  messageSenderJids,
  normalizedUser,
} from "./helpers.js";
import { readFirestoreCollectionRest, readFirestoreDocumentRest, writeFirestoreDocumentRest } from "./auth.js";
import { logger } from "./logger.js";

const LOCAL_META_MEMORY_FILE = path.join(process.cwd(), "data", "meta_memory.json");

const MAX_MESSAGES_PER_CHAT = 500;
const ONLINE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes recent activity window
const PRESENCE_LIVE_WINDOW_MS = 3 * 60 * 1000; // 3 minutes live presence signal window

// chatId -> Array<ChatHistoryEntry>
const chatHistoryMap = new Map();

// chatId -> Map<userNumber, PresenceEntry>
const chatPresenceMap = new Map();

// Global userNumber -> PresenceEntry
const globalPresenceMap = new Map();

// chatId -> ActiveGameSession
const activeGroupGames = new Map();

/**
 * Records an incoming or outgoing WhatsApp message in chat memory for conversation intelligence,
 * summarization, search, and message deletion operations ("delete my last 5 messages").
 */
export function recordChatMessage(userId, message, options = {}) {
  if (!message || !message.key?.remoteJid) return null;
  const chatId = message.key.remoteJid;
  if (chatId === "status@broadcast") return null;

  const messageId = message.key.id;
  if (!messageId) return null;

  const rawContent = getMessageContent(message);
  if (rawContent?.protocolMessage || rawContent?.reactionMessage) {
    return null;
  }

  const text = getMessageText(message) || options.textOverride || "";
  const mediaType = mediaTypeFromMessage(message) || options.mediaType || null;
  if (!text && !mediaType) return null;

  const fromMe = Boolean(message.key.fromMe ?? options.fromMe);
  const senderCandidates = messageSenderJids(message, chatId);
  const primarySender =
    (fromMe && options.botNumber ? `${options.botNumber}@s.whatsapp.net` : "") ||
    senderCandidates.find((j) => String(j).endsWith("@s.whatsapp.net")) ||
    senderCandidates[0] ||
    message.key.participant ||
    message.participant ||
    (fromMe ? options.ownJid || "" : "") ||
    chatId;

  const senderJid = normalizedUser(primarySender);
  const senderNumber = extractParticipantNumber(senderJid) || extractParticipantNumber(primarySender) || "";
  const senderAliases = new Set([
    ...senderCandidates.flatMap(jidAliases),
    ...(senderJid ? jidAliases(senderJid) : []),
    ...(senderNumber ? [senderNumber, `${senderNumber}@s.whatsapp.net`] : []),
    ...(fromMe && options.botNumber ? [options.botNumber, `${options.botNumber}@s.whatsapp.net`] : []),
  ]);

  const rawTs = Number(message.messageTimestamp || options.timestamp || 0);
  const timestamp = rawTs > 0 ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.now();

  const entry = {
    id: messageId,
    userId: userId || "default",
    chatId,
    senderJid,
    senderNumber,
    senderAliases,
    pushName: String(message.pushName || options.pushName || "").trim(),
    fromMe,
    isBotGenerated: Boolean(options.isBotGenerated),
    key: {
      remoteJid: chatId,
      fromMe,
      id: messageId,
      ...(message.key.participant || message.participant
        ? { participant: message.key.participant || message.participant }
        : {}),
    },
    text: String(text || "").trim(),
    mediaType,
    timestamp,
    rawMessage: message,
  };

  let list = chatHistoryMap.get(chatId);
  if (!list) {
    list = [];
    chatHistoryMap.set(chatId, list);
  }

  const existingIdx = list.findIndex((item) => item.id === messageId);
  if (existingIdx !== -1) {
    list[existingIdx] = { ...list[existingIdx], ...entry };
  } else {
    const lastTs = list.length > 0 ? list[list.length - 1].timestamp : 0;
    list.push(entry);
    if (options.isHistorical || (lastTs && entry.timestamp < lastTs)) {
      list.sort((a, b) => a.timestamp - b.timestamp);
    }
    if (list.length > MAX_MESSAGES_PER_CHAT) {
      list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    }
  }

  // Also update active presence from real message activity (skip old historical sync)
  if (senderNumber && !options.isBotGenerated && !options.isHistorical) {
    recordPresenceUpdate(chatId, senderJid || `${senderNumber}@s.whatsapp.net`, "available", {
      pushName: entry.pushName,
      source: "message",
      timestamp,
    });
  }

  return entry;
}

/**
 * Retrieves the last N messages in a chat for bulk admin deletion (including pre-existing synchronized messages,
 * commands, and bot messages, excluding only the trigger message itself).
 */
export function getChatHistoryForBulkDelete(chatId, count = 50, excludeMessageId = null) {
  const list = chatHistoryMap.get(chatId) || [];
  const candidates = list.filter((m) => m && m.id && m.id !== excludeMessageId);
  return candidates.slice(-Math.max(1, Math.min(200, count)));
}

/**
 * Removes a deleted message from chat history or marks it deleted.
 */
export function removeChatMessageById(chatId, messageId) {
  if (!chatId || !messageId) return false;
  const list = chatHistoryMap.get(chatId);
  if (!list) return false;
  const idx = list.findIndex((item) => item.id === messageId);
  if (idx === -1) return false;
  list.splice(idx, 1);
  return true;
}

/**
 * Retrieves recent messages for a chat.
 */
export function getChatHistory(chatId, options = {}) {
  const list = chatHistoryMap.get(chatId) || [];
  const {
    limit = 50,
    excludeCommands = true,
    excludeBotGenerated = true,
    sinceTimestamp = 0,
    searchQuery = "",
  } = options;

  let filtered = list.filter((item) => {
    if (sinceTimestamp && item.timestamp < sinceTimestamp) return false;
    if (excludeBotGenerated && item.isBotGenerated) return false;
    if (excludeCommands && item.text && /^\s*[.!\/#$](meta|ai|metaai)\b/i.test(item.text)) {
      return false;
    }
    return true;
  });

  if (searchQuery && String(searchQuery).trim()) {
    const terms = String(searchQuery)
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    if (terms.length > 0) {
      filtered = filtered.filter((item) => {
        const hay = `${item.text || ""} ${item.pushName || ""} ${item.senderNumber || ""}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
    }
  }

  if (limit && filtered.length > limit) {
    return filtered.slice(-limit);
  }
  return filtered;
}

/**
 * Finds the last N messages sent by a specific user (or the linked account owner) in a chat.
 */
export function getRecentMessagesBySender(chatId, senderCandidates = [], count = 5, options = {}) {
  const list = chatHistoryMap.get(chatId) || [];
  const { excludeMessageId = null, includeFromMe = true } = options;

  const wantedAliases = new Set(
    (Array.isArray(senderCandidates) ? senderCandidates : [senderCandidates])
      .filter(Boolean)
      .flatMap((j) => [ ...jidAliases(j), extractParticipantNumber(j) ])
      .filter(Boolean)
  );

  const matched = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (excludeMessageId && item.id === excludeMessageId) continue;

    let isMatch = false;
    if (includeFromMe && item.fromMe) {
      isMatch = true;
    } else if (item.senderNumber && wantedAliases.has(item.senderNumber)) {
      isMatch = true;
    } else if (item.senderJid && wantedAliases.has(item.senderJid)) {
      isMatch = true;
    } else if (item.senderAliases) {
      for (const alias of item.senderAliases) {
        if (wantedAliases.has(alias)) {
          isMatch = true;
          break;
        }
      }
    }

    if (isMatch) {
      matched.push(item);
      if (matched.length >= count) break;
    }
  }

  return matched;
}

/**
 * Records a WhatsApp presence update (`available`, `composing`, `recording`, `unavailable`)
 */
export function recordPresenceUpdate(chatId, participantJid, presenceState = "available", extra = {}) {
  const num = extractParticipantNumber(participantJid);
  const cleanJid = num ? `${num}@s.whatsapp.net` : normalizedUser(participantJid);
  const key = num || cleanJid;
  if (!key || key.endsWith("@g.us")) return;

  const now = extra.timestamp || Date.now();
  const isOnlineState =
    presenceState === "available" ||
    presenceState === "composing" ||
    presenceState === "recording";

  const existingChatMap = chatId ? chatPresenceMap.get(chatId) : null;
  const prev = (existingChatMap && existingChatMap.get(key)) || globalPresenceMap.get(key) || {};

  const updated = {
    key,
    userNumber: num || key.split("@")[0],
    userJid: cleanJid || `${num}@s.whatsapp.net`,
    pushName: extra.pushName || prev.pushName || "",
    presence: presenceState || prev.presence || "available",
    isOnline: isOnlineState,
    lastSeenOnlineAt: isOnlineState ? now : prev.lastSeenOnlineAt || 0,
    lastMessageAt: extra.source === "message" ? now : prev.lastMessageAt || 0,
    updatedAt: now,
  };

  globalPresenceMap.set(key, updated);

  if (chatId) {
    let map = chatPresenceMap.get(chatId);
    if (!map) {
      map = new Map();
      chatPresenceMap.set(chatId, map);
    }
    map.set(key, updated);
  }
}

/**
 * Returns currently online or recently active participants in a chat/group.
 */
export function getOnlineParticipantsForChat(chatId, groupMetadata = null) {
  const now = Date.now();
  const chatMap = chatPresenceMap.get(chatId) || new Map();
  const participants = Array.isArray(groupMetadata?.participants) ? groupMetadata.participants : [];

  const participantLookup = new Map();
  for (const p of participants) {
    const jids = [p.phoneNumber, p.jid, p.id, p.lid].filter(Boolean);
    const num =
      jids
        .filter((j) => String(j).endsWith("@s.whatsapp.net"))
        .map((j) => extractParticipantNumber(j))
        .find(Boolean) || extractParticipantNumber(p.id);
    if (num) {
      participantLookup.set(num, p);
    }
    for (const j of jids) {
      participantLookup.set(normalizedUser(j), p);
    }
  }

  const results = [];
  const seenKeys = new Set();

  const inspectEntry = (entry) => {
    if (!entry) return;
    const uKey = entry.userNumber || entry.key;
    if (!uKey || seenKeys.has(uKey)) return;

    // If group metadata is provided, verify participant is in the group
    let groupMember = null;
    if (participants.length > 0) {
      groupMember = participantLookup.get(uKey) || participantLookup.get(entry.userJid);
      if (!groupMember) return;
    }

    const ageSinceOnline = now - (entry.lastSeenOnlineAt || 0);
    const ageSinceMsg = now - (entry.lastMessageAt || 0);
    const isLiveOnline =
      (entry.isOnline && ageSinceOnline <= PRESENCE_LIVE_WINDOW_MS) ||
      ageSinceMsg <= PRESENCE_LIVE_WINDOW_MS;
    const isRecentlyActive =
      ageSinceOnline <= ONLINE_WINDOW_MS || ageSinceMsg <= ONLINE_WINDOW_MS;

    if (!isLiveOnline && !isRecentlyActive) return;

    seenKeys.add(uKey);
    const mentionJid =
      groupMember?.id ||
      groupMember?.phoneNumber ||
      entry.userJid ||
      `${entry.userNumber}@s.whatsapp.net`;

    let statusLabel = "🟢 Online";
    if (entry.presence === "composing" && ageSinceOnline < 60000) {
      statusLabel = "✍️ Typing now";
    } else if (entry.presence === "recording" && ageSinceOnline < 60000) {
      statusLabel = "🎙️ Recording audio";
    } else if (isLiveOnline) {
      statusLabel = "🟢 Online now";
    } else {
      const mins = Math.max(1, Math.round(Math.min(ageSinceOnline, ageSinceMsg) / 60000));
      statusLabel = `💬 Active ${mins}m ago`;
    }

    results.push({
      userNumber: entry.userNumber,
      userJid: entry.userJid,
      mentionJid,
      pushName: entry.pushName || groupMember?.notify || "",
      statusLabel,
      isLiveOnline,
      lastActiveAt: Math.max(entry.lastSeenOnlineAt || 0, entry.lastMessageAt || 0),
    });
  };

  for (const entry of chatMap.values()) {
    inspectEntry(entry);
  }
  for (const entry of globalPresenceMap.values()) {
    inspectEntry(entry);
  }

  results.sort((a, b) => {
    if (a.isLiveOnline !== b.isLiveOnline) return a.isLiveOnline ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });

  return results;
}

// ---------------------------------------------------------------------------
// GROUP GAMES & QUIZ ENGINE (Trivia Quiz, Riddles, Word Scramble, Math, Number Guess)
// ---------------------------------------------------------------------------

export const DEFAULT_QUIZ_BANK = [
  {
    question: "Which planet in our solar system is known as the Red Planet?",
    options: ["A) Venus", "B) Mars", "C) Jupiter", "D) Saturn"],
    answerLetter: "B",
    answerText: "mars",
    explanation: "Mars appears reddish due to iron oxide (rust) on its surface.",
  },
  {
    question: "What does 'HTTP' stand for in web addresses?",
    options: [
      "A) HyperText Transfer Protocol",
      "B) High Transmission Text Program",
      "C) Hyperlink Tracking Terminal Process",
      "D) Hybrid Text Transfer Platform",
    ],
    answerLetter: "A",
    answerText: "hypertext transfer protocol",
    explanation: "HTTP stands for HyperText Transfer Protocol.",
  },
  {
    question: "Which country has the largest population in Africa?",
    options: ["A) Egypt", "B) South Africa", "C) Ethiopia", "D) Nigeria"],
    answerLetter: "D",
    answerText: "nigeria",
    explanation: "Nigeria is the most populous country in Africa.",
  },
  {
    question: "How many bytes are in 1 Kilobyte (binary KB / KiB)?",
    options: ["A) 512", "B) 1000", "C) 1024", "D) 2048"],
    answerLetter: "C",
    answerText: "1024",
    explanation: "In binary computing, 1 KB (KiB) is 2^10 = 1,024 bytes.",
  },
  {
    question: "Which element has the chemical symbol 'Au'?",
    options: ["A) Silver", "B) Gold", "C) Aluminum", "D) Argon"],
    answerLetter: "B",
    answerText: "gold",
    explanation: "'Au' comes from the Latin word for gold, 'aurum'.",
  },
  {
    question: "In what year did the World Wide Web become publicly available?",
    options: ["A) 1985", "B) 1991", "C) 1998", "D) 2001"],
    answerLetter: "B",
    answerText: "1991",
    explanation: "Tim Berners-Lee made the World Wide Web publicly available in August 1991.",
  },
  {
    question: "Which organ in the human body is primarily responsible for pumping blood?",
    options: ["A) Lungs", "B) Brain", "C) Liver", "D) Heart"],
    answerLetter: "D",
    answerText: "heart",
    explanation: "The heart pumps blood throughout the circulatory system.",
  },
  {
    question: "What is the capital city of Japan?",
    options: ["A) Seoul", "B) Kyoto", "C) Tokyo", "D) Osaka"],
    answerLetter: "C",
    answerText: "tokyo",
    explanation: "Tokyo is the capital of Japan.",
  },
];

export const DEFAULT_RIDDLES = [
  {
    riddle: "I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?",
    acceptedAnswers: ["echo", "an echo"],
    displayAnswer: "An echo",
    hint: "You often hear me in a canyon or an empty hall.",
  },
  {
    riddle: "The more of this there is, the less you see. What is it?",
    acceptedAnswers: ["darkness", "dark", "the dark", "fog"],
    displayAnswer: "Darkness",
    hint: "Turn off all the lights and I fill the room.",
  },
  {
    riddle: "I have keys but no locks. I have space but no room. You can enter, but can't go outside. What am I?",
    acceptedAnswers: ["keyboard", "a keyboard", "computer keyboard"],
    displayAnswer: "A keyboard",
    hint: "You use me to type messages and code.",
  },
  {
    riddle: "What has to be broken before you can use it?",
    acceptedAnswers: ["egg", "an egg"],
    displayAnswer: "An egg",
    hint: "Commonly eaten for breakfast.",
  },
  {
    riddle: "I have cities, but no houses. I have mountains, but no trees. I have water, but no fish. What am I?",
    acceptedAnswers: ["map", "a map", "world map"],
    displayAnswer: "A map",
    hint: "Travelers use me to find their way.",
  },
];

export const DEFAULT_SCRAMBLE_WORDS = [
  { word: "ALGORITHM", scrambled: "MHTIROGLA", hint: "A step-by-step procedure used in computing" },
  { word: "WHATSAPP", scrambled: "PPASTAHW", hint: "The messaging platform we are using right now" },
  { word: "CHAMPION", scrambled: "NOIPMAHC", hint: "The winner of a tournament or competition" },
  { word: "DIAMOND", scrambled: "DNOMAID", hint: "The hardest naturally occurring gemstone" },
  { word: "NIGERIA", scrambled: "AIREGIN", hint: "A major West African nation" },
];

export function getActiveGame(chatId) {
  const game = activeGroupGames.get(chatId);
  if (!game) return null;
  // Auto-expire games inactive for more than 30 minutes
  if (Date.now() - game.updatedAt > 30 * 60 * 1000) {
    activeGroupGames.delete(chatId);
    return null;
  }
  return game;
}

export function startGroupGame(chatId, gameConfig) {
  const existing = activeGroupGames.get(chatId);
  const scores = existing?.scores || new Map();

  const session = {
    chatId,
    type: gameConfig.type || "quiz", // 'quiz' | 'riddle' | 'scramble' | 'number'
    title: gameConfig.title || "SOLVATECH GROUP QUIZ",
    questions: gameConfig.questions || [],
    currentIndex: 0,
    scores,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    keepScore: gameConfig.keepScore !== false,
    active: true,
  };

  activeGroupGames.set(chatId, session);
  return session;
}

export function stopGroupGame(chatId) {
  const existing = activeGroupGames.get(chatId);
  activeGroupGames.delete(chatId);
  return existing || null;
}

export function formatGameScoreboard(game) {
  if (!game || !game.scores || game.scores.size === 0) {
    return {
      text: "🏆 *CURRENT SCOREBOARD*\n_No points scored yet. Be the first to answer!_",
      mentions: [],
    };
  }

  const entries = Array.from(game.scores.values()).sort((a, b) => b.points - a.points);
  const medals = ["🥇", "🥈", "🥉"];
  const mentions = [];
  const lines = entries.slice(0, 10).map((entry, idx) => {
    const badge = medals[idx] || `${idx + 1}.`;
    const num = entry.userNumber || entry.jid.split("@")[0];
    if (entry.jid) mentions.push(entry.jid);
    return `${badge} @${num}${entry.name ? ` (${entry.name})` : ""} — *${entry.points} pt${entry.points === 1 ? "" : "s"}*`;
  });

  return {
    text: ["🏆 *GROUP GAME LEADERBOARD*", ...lines].join("\n"),
    mentions,
  };
}

export function formatCurrentGamePrompt(game) {
  if (!game || !game.active) return null;
  const current = game.questions[game.currentIndex];
  if (!current) return null;

  const total = game.questions.length;
  const roundHeader = total > 1 ? ` (Question ${game.currentIndex + 1}/${total})` : "";

  if (game.type === "quiz") {
    return [
      `🎮 *${game.title}${roundHeader}*`,
      "────────────────────────────",
      `❓ *${current.question}*`,
      "",
      ...(current.options || []),
      "",
      "💡 _Reply with *A*, *B*, *C*, or *D* (or the answer) in the chat!_",
    ].join("\n");
  }

  if (game.type === "riddle") {
    return [
      `🧩 *${game.title}${roundHeader}*`,
      "────────────────────────────",
      `❝ *${current.riddle}* ❞`,
      "",
      "💡 _Type your answer directly in the chat (or send *.meta hint* for a clue)!_",
    ].join("\n");
  }

  if (game.type === "scramble") {
    return [
      `🔤 *${game.title}${roundHeader}*`,
      "────────────────────────────",
      `Unscramble this word: *${current.scrambled}*`,
      `📌 *Clue:* ${current.hint}`,
      "",
      "💡 _Type the unscrambled word in the chat!_",
    ].join("\n");
  }

  if (game.type === "number") {
    return [
      `🎲 *${game.title}*`,
      "────────────────────────────",
      `I am thinking of a number between *${current.min}* and *${current.max}*.`,
      "",
      "💡 _Type your number guess in the chat!_",
    ].join("\n");
  }

  return null;
}

/**
 * Evaluates a chat message to see if it answers an active game/quiz in the chat.
 * Returns { matched: boolean, responseText?: string, mentions?: string[] }
 */
export function evaluateGameAnswer(chatId, rawText, senderJid, pushName = "") {
  const game = getActiveGame(chatId);
  if (!game || !game.active) return { matched: false };

  const current = game.questions[game.currentIndex];
  if (!current) return { matched: false };

  let clean = String(rawText || "").trim();
  // Strip optional .meta prefix if participant answered with `.meta B`
  clean = clean.replace(/^\s*[.!\/#$](meta|ai|metaai)\s+/i, "").trim();
  if (!clean) return { matched: false };

  const lower = clean.toLowerCase().replace(/[.!?]+$/g, "").trim();
  const senderNum = extractParticipantNumber(senderJid) || String(senderJid || "").split("@")[0];
  const canonicalSenderJid = senderNum ? `${senderNum}@s.whatsapp.net` : normalizedUser(senderJid);

  const awardPoint = (pts = 10) => {
    const prev = game.scores.get(senderNum) || {
      userNumber: senderNum,
      jid: canonicalSenderJid,
      name: pushName || "",
      points: 0,
    };
    prev.points += pts;
    if (pushName) prev.name = pushName;
    game.scores.set(senderNum, prev);
    game.updatedAt = Date.now();
  };

  if (game.type === "quiz") {
    const letterMatch = lower.match(/^(?:option\s+)?([abcd])(?:\)|\s|$)/i);
    const chosenLetter = letterMatch ? letterMatch[1].toUpperCase() : null;
    const isExactAnswer =
      (chosenLetter && chosenLetter === String(current.answerLetter).toUpperCase()) ||
      (current.answerText && lower === String(current.answerText).toLowerCase());

    // Check if they typed one of the wrong option texts or letters
    const matchedWrongOption =
      !isExactAnswer &&
      (Boolean(chosenLetter) ||
        (Array.isArray(current.options) &&
          current.options.some((opt) => {
            const stripped = String(opt)
              .replace(/^[A-D]\)\s*/i, "")
              .trim()
              .toLowerCase();
            return stripped && lower === stripped;
          })));

    if (matchedWrongOption) {
      return {
        matched: true,
        mentions: [canonicalSenderJid],
        responseText: `❌ Not quite, @${senderNum}! *${chosenLetter || clean}* is not the right answer. Try another option!`,
      };
    }

    if (!isExactAnswer) {
      return { matched: false };
    }

    awardPoint(10);
    game.currentIndex += 1;
    const hasMore = game.currentIndex < game.questions.length;
    const board = formatGameScoreboard(game);
    const mentions = [...new Set([canonicalSenderJid, ...board.mentions])];

    if (hasMore) {
      const nextPrompt = formatCurrentGamePrompt(game);
      return {
        matched: true,
        mentions,
        responseText: [
          `✅ *CORRECT!* 🎉 @${senderNum} got it right! (+10 pts)`,
          current.explanation ? `ℹ️ _${current.explanation}_` : "",
          "",
          board.text,
          "",
          nextPrompt,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    stopGroupGame(chatId);
    return {
      matched: true,
      mentions,
      responseText: [
        `✅ *CORRECT!* 🎉 @${senderNum} nailed the final question! (+10 pts)`,
        current.explanation ? `ℹ️ _${current.explanation}_` : "",
        "",
        "🏁 *QUIZ COMPLETED!*",
        board.text,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (game.type === "riddle") {
    const accepted = (current.acceptedAnswers || []).map((a) => a.toLowerCase());
    const isCorrect = accepted.some((ans) => lower === ans || lower === `a ${ans}` || lower === `an ${ans}` || lower.includes(ans));
    if (!isCorrect) return { matched: false };

    awardPoint(15);
    game.currentIndex += 1;
    const hasMore = game.currentIndex < game.questions.length;
    const board = formatGameScoreboard(game);
    const mentions = [...new Set([canonicalSenderJid, ...board.mentions])];

    if (hasMore) {
      const nextPrompt = formatCurrentGamePrompt(game);
      return {
        matched: true,
        mentions,
        responseText: [
          `🎯 *RIDDLE SOLVED!* 🧠 @${senderNum} answered *${current.displayAnswer}*! (+15 pts)`,
          "",
          board.text,
          "",
          nextPrompt,
        ].join("\n"),
      };
    }

    stopGroupGame(chatId);
    return {
      matched: true,
      mentions,
      responseText: [
        `🎯 *RIDDLE SOLVED!* 🧠 @${senderNum} answered *${current.displayAnswer}*! (+15 pts)`,
        "",
        board.text,
      ].join("\n"),
    };
  }

  if (game.type === "scramble") {
    if (lower !== String(current.word).toLowerCase()) {
      return { matched: false };
    }
    awardPoint(10);
    game.currentIndex += 1;
    const hasMore = game.currentIndex < game.questions.length;
    const board = formatGameScoreboard(game);
    const mentions = [...new Set([canonicalSenderJid, ...board.mentions])];

    if (hasMore) {
      const nextPrompt = formatCurrentGamePrompt(game);
      return {
        matched: true,
        mentions,
        responseText: [
          `🔤 *UNSCRAMBLED!* 🎉 @${senderNum} solved *${current.word}*! (+10 pts)`,
          "",
          board.text,
          "",
          nextPrompt,
        ].join("\n"),
      };
    }

    stopGroupGame(chatId);
    return {
      matched: true,
      mentions,
      responseText: [
        `🔤 *UNSCRAMBLED!* 🎉 @${senderNum} solved *${current.word}*! (+10 pts)`,
        "",
        board.text,
      ].join("\n"),
    };
  }

  if (game.type === "number") {
    if (!/^\d{1,3}$/.test(lower)) return { matched: false };
    const guess = parseInt(lower, 10);
    if (guess < current.min || guess > current.max) return { matched: false };

    current.attempts = (current.attempts || 0) + 1;
    game.updatedAt = Date.now();

    if (guess === current.target) {
      awardPoint(20);
      const board = formatGameScoreboard(game);
      stopGroupGame(chatId);
      return {
        matched: true,
        mentions: [...new Set([canonicalSenderJid, ...board.mentions])],
        responseText: [
          `🎯 *BULLSEYE!* 🎉 @${senderNum} guessed the secret number *${current.target}* in ${current.attempts} attempt(s)! (+20 pts)`,
          "",
          board.text,
        ].join("\n"),
      };
    }

    const direction = guess < current.target ? "📈 *Higher!*" : "📉 *Lower!*";
    return {
      matched: true,
      mentions: [canonicalSenderJid],
      responseText: `${direction} @${senderNum}, the secret number is ${guess < current.target ? "greater" : "less"} than *${guess}*.`,
    };
  }

  return { matched: false };
}

// ---------------------------------------------------------------------------
// CONTINUOUS META CHAT MODE & DEEP PERSISTENT MEMORY (PUBLIC EVERYWHERE)
// ---------------------------------------------------------------------------

// Key: `${userId}::${chatId}` -> MetaChatSession
const metaChatSessions = new Map();

// Key: `${userId}::${chatId}::${senderKey}` -> PendingClarification
const pendingClarifications = new Map();

// Key: `${userId}::${chatId}` -> Array<{ role: 'user' | 'assistant', senderName?: string, content: string, timestamp: number }>
const aiConversationHistory = new Map();

// Key: `${userId}::${chatId}` -> Array<{ fact: string, addedBy: string, timestamp: number }>
const deepMemoryStore = new Map();

function makeMetaKey(userId = "default", chatId = "") {
  return `${userId || "default"}::${chatId}`;
}

function sanitizeDocKey(str = "") {
  return String(str || "").replace(/[\/\s:]/g, "_");
}

let isMetaChatsLoaded = false;

/**
 * Returns known active WhatsApp phone numbers starting with a given country dial code
 * from global presence and chat history (excluding numbers already in excludeSet).
 */
export function getKnownWhatsAppNumbersForCountry(dialCode = "", excludeSet = new Set()) {
  const code = String(dialCode || "").replace(/\D/g, "");
  if (!code) return [];
  const results = [];
  const seen = new Set(excludeSet);

  for (const entry of globalPresenceMap.values()) {
    const num = String(entry?.userNumber || "").replace(/\D/g, "");
    if (num && num.startsWith(code) && num.length >= code.length + 7 && !seen.has(num)) {
      seen.add(num);
      results.push(num);
    }
  }

  for (const list of chatHistoryMap.values()) {
    for (const msg of list) {
      const num = String(msg?.senderNumber || "").replace(/\D/g, "");
      if (num && num.startsWith(code) && num.length >= code.length + 7 && !seen.has(num)) {
        seen.add(num);
        results.push(num);
      }
    }
  }

  return results;
}

function loadLocalMetaMemorySync() {
  try {
    if (!fs.existsSync(LOCAL_META_MEMORY_FILE)) return;
    const raw = fs.readFileSync(LOCAL_META_MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    if (parsed.sessions && typeof parsed.sessions === "object") {
      for (const [key, session] of Object.entries(parsed.sessions)) {
        if (session && session.enabled) {
          metaChatSessions.set(key, session);
        }
      }
    }
    if (parsed.conversations && typeof parsed.conversations === "object") {
      for (const [key, turns] of Object.entries(parsed.conversations)) {
        if (Array.isArray(turns)) {
          aiConversationHistory.set(key, turns.slice(-60));
        }
      }
    }
    if (parsed.memories && typeof parsed.memories === "object") {
      for (const [key, facts] of Object.entries(parsed.memories)) {
        if (Array.isArray(facts)) {
          deepMemoryStore.set(key, facts.slice(-150));
        }
      }
    }
  } catch {}
}

let localSaveTimer = null;
function saveLocalMetaMemoryDebounced() {
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    localSaveTimer = null;
    try {
      const dir = path.dirname(LOCAL_META_MEMORY_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const sessionsObj = {};
      for (const [k, v] of metaChatSessions.entries()) {
        if (v?.enabled) sessionsObj[k] = v;
      }
      const convObj = {};
      for (const [k, v] of aiConversationHistory.entries()) {
        if (Array.isArray(v) && v.length > 0) convObj[k] = v.slice(-60);
      }
      const memObj = {};
      for (const [k, v] of deepMemoryStore.entries()) {
        if (Array.isArray(v) && v.length > 0) memObj[k] = v.slice(-150);
      }
      fs.writeFileSync(
        LOCAL_META_MEMORY_FILE,
        JSON.stringify({ sessions: sessionsObj, conversations: convObj, memories: memObj }, null, 2),
        "utf8"
      );
    } catch {}
  }, 600);
}

// Load from local disk immediately on startup
loadLocalMetaMemorySync();

export async function syncMetaChatsFromFirestore() {
  try {
    const docs = await readFirestoreCollectionRest("meta_chats");
    for (const data of docs || []) {
      if (data && data.userId && data.chatId) {
        const key = makeMetaKey(data.userId, data.chatId);
        if (data.enabled) {
          metaChatSessions.set(key, {
            userId: data.userId,
            chatId: data.chatId,
            chatName: data.chatName || "Chat",
            isGroup: Boolean(data.isGroup),
            enabled: true,
            mode: "public",
            strictPrivate: false,
            activatedAt: data.activatedAt || Date.now(),
            updatedAt: data.updatedAt || Date.now(),
          });
        }
        if (Array.isArray(data.conversationTurns) && data.conversationTurns.length > 0) {
          aiConversationHistory.set(key, data.conversationTurns.slice(-60));
        }
        if (Array.isArray(data.deepMemories) && data.deepMemories.length > 0) {
          deepMemoryStore.set(key, data.deepMemories.slice(-150));
        }
      }
    }
    isMetaChatsLoaded = true;
    saveLocalMetaMemoryDebounced();
  } catch (e) {
    logger.debug("Firestore meta_chats load notice", e.message);
  }
}

// Auto-sync in background on module load
syncMetaChatsFromFirestore().catch(() => {});

function persistMetaChatStateToFirestore(userId, chatId) {
  if (!chatId) return;
  saveLocalMetaMemoryDebounced();
  const key = makeMetaKey(userId, chatId);
  const docId = sanitizeDocKey(`${userId || "default"}_${chatId}`);
  const session = metaChatSessions.get(key);
  const conversationTurns = (aiConversationHistory.get(key) || []).slice(-50);
  const deepMemories = (deepMemoryStore.get(key) || []).slice(-120);

  const payload = {
    userId: userId || "default",
    chatId,
    chatName: session?.chatName || (String(chatId).endsWith("@g.us") ? "Group Chat" : `+${extractParticipantNumber(chatId) || chatId.split("@")[0]}`),
    isGroup: String(chatId).endsWith("@g.us"),
    enabled: Boolean(session?.enabled),
    mode: "public",
    strictPrivate: false,
    activatedAt: session?.activatedAt || Date.now(),
    updatedAt: Date.now(),
    conversationTurns,
    deepMemories,
  };

  writeFirestoreDocumentRest("meta_chats", docId, payload).catch(() => {});
}

export function setMetaChatMode(userId = "default", chatId = "", config = {}) {
  if (!chatId) return null;
  const key = makeMetaKey(userId, chatId);
  const prev = metaChatSessions.get(key) || {};
  const enabled = config.enabled !== undefined ? Boolean(config.enabled) : true;

  if (!enabled) {
    metaChatSessions.delete(key);
    persistMetaChatStateToFirestore(userId, chatId);
    return null;
  }

  // Meta is ALWAYS public everywhere when turned ON
  const isGroupChat = String(chatId).endsWith("@g.us");
  const updated = {
    userId: userId || "default",
    chatId,
    chatName: config.chatName || prev.chatName || (isGroupChat ? "Group Chat" : `+${extractParticipantNumber(chatId) || chatId.split("@")[0]}`),
    isGroup: isGroupChat,
    enabled: true,
    mode: "public",
    strictPrivate: false,
    activatedAt: prev.activatedAt || Date.now(),
    updatedAt: Date.now(),
  };

  metaChatSessions.set(key, updated);
  persistMetaChatStateToFirestore(userId, chatId);

  return updated;
}

export function updateMetaChatName(userId = "default", chatId = "", chatName = "") {
  if (!chatId || !chatName) return;
  const key = makeMetaKey(userId, chatId);
  const existing = metaChatSessions.get(key);
  if (existing && existing.enabled) {
    existing.chatName = String(chatName).trim();
  }
}

export function getMetaChatMode(userId = "default", chatId = "") {
  if (!chatId) return null;
  const key = makeMetaKey(userId, chatId);
  const session = metaChatSessions.get(key);
  if (!session || !session.enabled) return null;
  return session;
}

export function disableAllMetaChats(userId = "default") {
  const uid = userId || "default";
  const removed = [];
  for (const [key, session] of metaChatSessions.entries()) {
    if (session.userId === uid && session.enabled) {
      removed.push(session);
      metaChatSessions.delete(key);
      persistMetaChatStateToFirestore(uid, session.chatId);
    }
  }
  for (const [cKey] of pendingClarifications.entries()) {
    if (cKey.startsWith(`${uid}::`)) {
      pendingClarifications.delete(cKey);
    }
  }
  return removed;
}

export function listActiveMetaChats(userId = "default") {
  const uid = userId || "default";
  const active = [];
  for (const session of metaChatSessions.values()) {
    if (session.userId === uid && session.enabled) {
      active.push(session);
    }
  }
  active.sort((a, b) => b.updatedAt - a.updatedAt);
  return active;
}

// ---------------------------------------------------------------------------
// INTERACTIVE PENDING CLARIFICATIONS
// ---------------------------------------------------------------------------

const CLARIFICATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function setPendingClarification(userId = "default", chatId = "", senderJid = "", payload = {}) {
  if (!chatId) return null;
  const senderKey = extractParticipantNumber(senderJid) || normalizedUser(senderJid) || "owner";
  const key = `${userId || "default"}::${chatId}::${senderKey}`;
  const chatWideKey = `${userId || "default"}::${chatId}::chat`;
  const entry = {
    ...payload,
    userId: userId || "default",
    chatId,
    senderKey,
    createdAt: Date.now(),
  };
  pendingClarifications.set(key, entry);
  pendingClarifications.set(chatWideKey, entry);
  return entry;
}

export function getPendingClarification(userId = "default", chatId = "", senderJid = "") {
  if (!chatId) return null;
  const senderKey = extractParticipantNumber(senderJid) || normalizedUser(senderJid) || "owner";
  const key = `${userId || "default"}::${chatId}::${senderKey}`;
  const fallbackKey = `${userId || "default"}::${chatId}::owner`;
  const chatWideKey = `${userId || "default"}::${chatId}::chat`;
  const entry =
    pendingClarifications.get(key) ||
    pendingClarifications.get(fallbackKey) ||
    pendingClarifications.get(chatWideKey);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CLARIFICATION_TTL_MS) {
    pendingClarifications.delete(key);
    pendingClarifications.delete(fallbackKey);
    pendingClarifications.delete(chatWideKey);
    return null;
  }
  return entry;
}

export function clearPendingClarification(userId = "default", chatId = "", senderJid = "") {
  if (!chatId) return;
  const senderKey = extractParticipantNumber(senderJid) || normalizedUser(senderJid) || "owner";
  pendingClarifications.delete(`${userId || "default"}::${chatId}::${senderKey}`);
  pendingClarifications.delete(`${userId || "default"}::${chatId}::owner`);
  pendingClarifications.delete(`${userId || "default"}::${chatId}::chat`);
}

// ---------------------------------------------------------------------------
// DEEP PERSISTENT CONVERSATIONAL MEMORY & LONG-TERM FACTS PER CHAT
// ---------------------------------------------------------------------------

export function recordDeepMemoryFact(userId = "default", chatId = "", factText = "", addedBy = "") {
  if (!chatId || !factText) return;
  const cleanFact = String(factText).trim();
  if (cleanFact.length < 3) return;
  const key = makeMetaKey(userId, chatId);
  let facts = deepMemoryStore.get(key);
  if (!facts) {
    facts = [];
    deepMemoryStore.set(key, facts);
  }
  // Avoid exact duplicates
  if (!facts.some((f) => f.fact.toLowerCase() === cleanFact.toLowerCase())) {
    facts.push({
      fact: cleanFact,
      addedBy: String(addedBy || "User").trim(),
      timestamp: Date.now(),
    });
    if (facts.length > 80) {
      facts.splice(0, facts.length - 80);
    }
    persistMetaChatStateToFirestore(userId, chatId);
  }
}

export function getDeepMemoryFacts(userId = "default", chatId = "") {
  if (!chatId) return [];
  const key = makeMetaKey(userId, chatId);
  return deepMemoryStore.get(key) || [];
}

export function recordAIConversationTurn(
  userId = "default",
  chatId = "",
  userText = "",
  assistantText = "",
  senderName = ""
) {
  if (!chatId || !userText || !assistantText) return;
  const key = makeMetaKey(userId, chatId);
  let turns = aiConversationHistory.get(key);
  if (!turns) {
    turns = [];
    aiConversationHistory.set(key, turns);
  }
  const cleanUser = String(userText).trim();
  turns.push(
    {
      role: "user",
      senderName: String(senderName || "").trim(),
      content: cleanUser,
      timestamp: Date.now(),
    },
    {
      role: "assistant",
      content: String(assistantText).trim(),
      timestamp: Date.now(),
    }
  );
  if (turns.length > 60) {
    turns.splice(0, turns.length - 60);
  }

  // Automatically extract personal facts/preferences/instructions into deep memory when user states them
  if (
    /\b(?:my\s+name\s+is|call\s+me|i\s+am\s+from|i'?m\s+from|i\s+live\s+in|my\s+favorite|i\s+like|i\s+love|remember|don'?t\s+forget|never\s+forget|i\s+work\s+as|my\s+birthday|my\s+number\s+is|note\s+that|keep\s+in\s+mind)\b/i.test(
      cleanUser
    )
  ) {
    recordDeepMemoryFact(
      userId,
      chatId,
      `${senderName ? `${senderName}: ` : ""}${cleanUser}`,
      senderName || "User"
    );
  } else {
    persistMetaChatStateToFirestore(userId, chatId);
  }
}

export function getAIConversationHistory(userId = "default", chatId = "", maxMessages = 36) {
  if (!chatId) return [];
  const key = makeMetaKey(userId, chatId);
  const turns = aiConversationHistory.get(key) || [];
  if (turns.length >= 6) {
    return turns.slice(-maxMessages);
  }

  // Supplement with recent raw chat messages from chatHistoryMap so Meta never forgets recent chat context
  const rawList = chatHistoryMap.get(chatId) || [];
  const supplemented = rawList
    .filter((m) => m.text && !m.text.startsWith("."))
    .slice(-maxMessages)
    .map((m) => ({
      role: m.isBotGenerated ? "assistant" : "user",
      senderName: m.pushName || (m.senderNumber ? `+${m.senderNumber}` : ""),
      content: m.text,
      timestamp: m.timestamp,
    }));

  return supplemented.length > turns.length ? supplemented.slice(-maxMessages) : turns.slice(-maxMessages);
}

