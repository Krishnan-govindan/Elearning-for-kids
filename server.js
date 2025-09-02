// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();

/* ----------------------- CONFIG ----------------------- */
const STT_MODEL = process.env.STT_MODEL || "whisper-1";
const CLEAN_TRANSCRIPT = String(process.env.CLEAN_TRANSCRIPT || "false").toLowerCase() === "true";

/* CORS */
app.use(cors({
  origin: [
    "https://india-therapist-chatbot.onrender.com",
    "https://krishnan-govindan.github.io"
  ],
  methods: ["GET","POST"],
}));

const upload = multer({ storage: multer.memoryStorage() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* Serve static files from repo root */
app.use(express.static("."));
app.use(express.json());

/* UI label -> ISO code for STT language hint */
const ISO = {
  English:"en", Hindi:"hi", Tamil:"ta", Telugu:"te", Kannada:"kn",
  Malayalam:"ml", Marathi:"mr", Gujarati:"gu", Bengali:"bn",
  Punjabi:"pa", Panjabi:"pa"
};

/* ----------------------- SIMPLE IN-MEMORY STORE -----------------------
   NOTE: This resets when the server restarts (Render free plan).
   For persistence, plug a KV/Redis later.
------------------------------------------------------------------------ */
const chats = new Map(); // conversationId -> [{role, content}]
const MAX_TURNS = 6;     // keep last 6 Q&A pairs (≈ 12 messages)

function getHistory(id) {
  return chats.get(id) || [];
}
function saveTurn(id, userText, assistantText) {
  const h = chats.get(id) || [];
  h.push({ role: "user", content: userText });
  h.push({ role: "assistant", content: assistantText });
  // trim to last MAX_TURNS*2 messages
  const trimmed = h.slice(-MAX_TURNS * 2);
  chats.set(id, trimmed);
}

/* ----------------------- ROUTES ----------------------- */

// Clear a conversation explicitly
app.post("/api/new", (req, res) => {
  const { conversationId } = req.body || {};
  if (conversationId && chats.has(conversationId)) chats.delete(conversationId);
  res.json({ ok: true });
});

app.post("/api/ask", upload.single("audio"), async (req, res) => {
  try {
    const answerLanguage = (req.body.answerLanguage || "").trim();
    const speakLanguage  = (req.body.speakLanguage  || "").trim();
    const conversationId = (req.body.conversationId || "").trim(); // required from client

    if (!conversationId) {
      return res.status(400).json({ error: "missing_conversation", message: "No conversationId provided." });
    }
    if (!answerLanguage || !speakLanguage) {
      return res.status(400).json({ error: "missing_language", message: "Please select both Speaking and Answer languages." });
    }
    if (!req.file || req.file.size < 5000) {
      return res.status(400).json({ error: "audio_too_short", message: "Please record at least 1 second of audio." });
    }

    /* 1) SPEECH -> TEXT (force language) */
    const stt = await openai.audio.transcriptions.create({
      file: await toFile(req.file.buffer, "speech.webm", { type: "audio/webm" }),
      model: STT_MODEL,
      language: ISO[speakLanguage] || undefined,
      prompt: `This is a child speaking ${speakLanguage} about school topics. Keep output in ${speakLanguage}.`
    });

    let userText = (stt.text || "").trim();

    /* Optional cleanup */
    if (CLEAN_TRANSCRIPT && userText) {
      const cleaned = await openai.responses.create({
        model: "gpt-5",
        input: [
          { role: "system", content: `Fix obvious transcription errors in ${speakLanguage} child speech. Return only the corrected text.` },
          { role: "user", content: userText }
        ]
      });
      userText = (cleaned.output_text || userText).trim();
    }

    /* 2) Build messages with HISTORY + kid-safe system prompt */
    const systemPrompt =
      `You are a ${answerLanguage} kids e-learning helper for Indian kids. ` +
      `Use very simple words, short sentences, and a warm, encouraging tone. ` +
      `Explain clearly with tiny examples. If the kid asks follow-up questions, use the chat history to stay on topic. ` +
      `Avoid any adult, harmful, or unsafe content. Always answer in ${answerLanguage}.`;

    const history = getHistory(conversationId); // [{role, content}, ...]
    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userText }
    ];

    const resp = await openai.responses.create({
      model: "gpt-5",
      input: messages
    });
    const assistantText = (resp.output_text || "").trim();

    // Save this turn to memory
    saveTurn(conversationId, userText, assistantText);

    /* 3) TEXT -> SPEECH (answer audio) */
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: assistantText,
      format: "mp3"
    });
    const base64Audio = Buffer.from(await speech.arrayBuffer()).toString("base64");

    return res.json({
      stt_model: STT_MODEL,
      conversationId,
      transcript: userText,
      text: assistantText,
      audioBase64: base64Audio
    });

  } catch (err) {
    const msg = (err?.error?.message || err?.message || "").toLowerCase();
    if (msg.includes("shorter than") || msg.includes("too short")) {
      return res.status(400).json({ error: "audio_too_short", message: "Audio too short. Please hold for at least 1 second." });
    }
    if (msg.includes("invalid") && msg.includes("language")) {
      return res.status(400).json({ error: "invalid_language", message: "Unsupported language code. Please pick a different language." });
    }
    console.error("API error:", err);
    return res.status(500).json({ error: "processing_failed", message: "Something went wrong while processing audio." });
  }
});

/* ----------------------- START ----------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}. STT_MODEL=${STT_MODEL} CLEAN_TRANSCRIPT=${CLEAN_TRANSCRIPT}`));
