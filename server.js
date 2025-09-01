// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();

/* ----------------------- CONFIG ----------------------- */
/** Choose STT model without changing code:
 *  STT_MODEL=whisper-1           (recommended for Indian accents)
 *  STT_MODEL=gpt-4o-transcribe   (fast/modern)
 */
const STT_MODEL = process.env.STT_MODEL || "whisper-1";

/** Optional: run a post-cleaning pass on transcripts with GPT
 *  CLEAN_TRANSCRIPT=true
 */
const CLEAN_TRANSCRIPT = String(process.env.CLEAN_TRANSCRIPT || "false").toLowerCase() === "true";

/* Allow your frontends */
app.use(cors({
  origin: [
    "https://india-therapist-chatbot.onrender.com", // Render app
    "https://krishnan-govindan.github.io"          // GitHub Pages domain
  ],
  methods: ["GET","POST"],
}));

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* Serve static files from repo root (index.html lives here) */
app.use(express.static("."));

/* UI label -> ISO code for STT language hint */
const ISO = {
  English:  "en",
  Hindi:    "hi",
  Tamil:    "ta",
  Telugu:   "te",
  Kannada:  "kn",
  Malayalam:"ml",
  Marathi:  "mr",
  Gujarati: "gu",
  Bengali:  "bn",
  Punjabi:  "pa",
  Panjabi:  "pa"  // in case the UI spells it Panjabi
};

/* ----------------------- ROUTES ----------------------- */
app.post("/api/ask", upload.single("audio"), async (req, res) => {
  try {
    const answerLanguage = (req.body.answerLanguage || "").trim();
    const speakLanguage  = (req.body.speakLanguage  || "").trim();

    if (!answerLanguage || !speakLanguage) {
      return res.status(400).json({ error: "missing_language", message: "Please select both Speaking and Answer languages." });
    }
    if (!req.file || req.file.size < 5000) {
      return res.status(400).json({ error: "audio_too_short", message: "Please record at least 1 second of audio." });
    }

    /* 1) SPEECH -> TEXT  (force language, add bias prompt) */
    const stt = await openai.audio.transcriptions.create({
      file: await toFile(req.file.buffer, "speech.webm", { type: "audio/webm" }),
      model: STT_MODEL,                                  // "whisper-1" or "gpt-4o-transcribe"
      language: ISO[speakLanguage] || undefined,         // <- force the spoken language
      prompt: `This is a child speaking ${speakLanguage} about school, math, and science.`
    });

    let userText = (stt.text || "").trim();

    /* Optional cleanup to fix minor spelling/spacing */
    if (CLEAN_TRANSCRIPT && userText) {
      const cleaned = await openai.responses.create({
        model: "gpt-5",
        input: [
          { role: "system", content: `You are a text cleaner. Fix obvious transcription errors in ${speakLanguage} child speech without changing meaning. Return only the corrected text.` },
          { role: "user", content: userText }
        ]
      });
      userText = (cleaned.output_text || userText).trim();
    }

    /* 2) REASONING (kids tutor) */
    const systemPrompt =
      `You are a ${answerLanguage} kids e-learning helper for Indian kids. ` +
      `This API key is intended for child-friendly educational use. ` +
      `Use age-appropriate, simple words, short sentences, and a warm tone. ` +
      `Explain clearly with tiny examples. Clarify the kid's doubt. ` +
      `Avoid any adult or harmful content. Always answer in ${answerLanguage}.`;

    const resp = await openai.responses.create({
      model: "gpt-5",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ]
    });
    const assistantText = (resp.output_text || "").trim();

    /* 3) TEXT -> SPEECH (answer audio) */
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",      // try: aria, breeze, coral, verse...
      input: assistantText,
      format: "mp3"
    });

    const base64Audio = Buffer.from(await speech.arrayBuffer()).toString("base64");

    return res.json({
      stt_model: STT_MODEL,
      transcript: userText,
      text: assistantText,
      audioBase64: base64Audio
    });

  } catch (err) {
    const msg = (err?.error?.message || err?.message || "").toLowerCase();

    // Friendly returns for common issues
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
