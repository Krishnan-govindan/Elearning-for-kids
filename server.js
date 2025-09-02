// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();

const STT_MODEL = process.env.STT_MODEL || "whisper-1";
const CLEAN_TRANSCRIPT = String(process.env.CLEAN_TRANSCRIPT || "false").toLowerCase() === "true";

app.use(cors({
  origin: [
    "https://india-therapist-chatbot.onrender.com",
    "https://krishnan-govindan.github.io"
  ],
  methods: ["GET", "POST"],
}));

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("."));
app.use(express.json());

const ISO = {
  English:"en", Hindi:"hi", Tamil:"ta", Telugu:"te", Kannada:"kn",
  Malayalam:"ml", Marathi:"mr", Gujarati:"gu", Bengali:"bn",
  Punjabi:"pa", Panjabi:"pa"
};

app.post("/api/ask", upload.single("audio"), async (req, res) => {
  try {
    const answerLanguage = (req.body.answerLanguage || "").trim();
    const speakLanguage  = (req.body.speakLanguage  || "").trim();
    const conversationId = (req.body.conversationId || "").trim();

    if (!conversationId) {
      return res.status(400).json({ error: "missing_conversation", message: "No conversationId provided." });
    }
    if (!answerLanguage || !speakLanguage) {
      return res.status(400).json({ error: "missing_language", message: "Please select both Speaking and Answer languages." });
    }
    if (!req.file || req.file.size < 5000) {
      return res.status(400).json({ error: "audio_too_short", message: "Please record at least 1 second of audio." });
    }

    // Parse optional history sent by client
    let clientHistory = [];
    if (req.body.history) {
      try {
        const parsed = JSON.parse(req.body.history);
        // expect [{role:"user"|"assistant", content:"..."}]
        if (Array.isArray(parsed)) clientHistory = parsed;
      } catch (_) {
        // ignore bad history
      }
    }
    // Keep last 6 turns (≈ 12 msgs)
    const MAX_TURNS = 6;
    const safeHistory = clientHistory.slice(-MAX_TURNS * 2);

    // 1) Speech -> Text
    const stt = await openai.audio.transcriptions.create({
      file: await toFile(req.file.buffer, "speech.webm", { type: "audio/webm" }),
      model: STT_MODEL,
      language: ISO[speakLanguage] || undefined,
      prompt: `This is a child speaking ${speakLanguage} about school topics. Keep output in ${speakLanguage}.`
    });
    let userText = (stt.text || "").trim();

    // Optional cleanup
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

    // 2) Reasoning with history
    const systemPrompt =
      `You are a ${answerLanguage} kids e-learning helper for Indian kids. ` +
      `This API key is for child-friendly education. Use very simple words, short sentences, warm tone. ` +
      `Use the chat history to keep continuity and clarify doubts with tiny examples. ` +
      `Avoid adult/harmful content. Always answer in ${answerLanguage}.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...safeHistory,
      { role: "user", content: userText }
    ];

    const resp = await openai.responses.create({
      model: "gpt-5",
      input: messages
    });
    const assistantText = (resp.output_text || "").trim();

    // 3) TTS
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: assistantText,
      format: "mp3"
    });
    const base64Audio = Buffer.from(await speech.arrayBuffer()).toString("base64");

    res.json({
      conversationId,
      transcript: userText,
      text: assistantText,
      audioBase64: base64Audio
    });

  } catch (err) {
    const msg = (err?.error?.message || err?.message || "").toLowerCase();
    if (msg.includes("shorter than") || msg.includes("too short")) {
      return res.status(400).json({ error: "audio_too_short", message: "Audio too short. Please record at least 1 second." });
    }
    if (msg.includes("invalid") && msg.includes("language")) {
      return res.status(400).json({ error: "invalid_language", message: "Unsupported language code." });
    }
    console.error("API error:", err);
    return res.status(500).json({ error: "processing_failed", message: "Something went wrong while processing audio." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}. STT_MODEL=${STT_MODEL} CLEAN_TRANSCRIPT=${CLEAN_TRANSCRIPT}`));
