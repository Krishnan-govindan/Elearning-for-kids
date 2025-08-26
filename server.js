import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();

// allow your Render app + GitHub Pages (add more origins if needed)
app.use(cors({
  origin: [
    "https://india-therapist-chatbot.onrender.com",
    "https://krishnan-govindan.github.io"
  ],
  methods: ["GET","POST"],
}));

const upload = multer({ storage: multer.memoryStorage() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// serve static from repo root (index.html lives here)
app.use(express.static("."));

// simple map from UI value to ISO code for STT hint
const ISO = {
  English: "en",
  Hindi: "hi",
  Tamil: "ta",
  Telugu: "te",
  Kannada: "kn",
  Malayalam: "ml",
  Marathi: "mr",
  Gujarati: "gu",
  Bengali: "bn",
  Punjabi: "pa"
};

app.post("/api/ask", upload.single("audio"), async (req, res) => {
  try {
    const answerLanguage = (req.body.answerLanguage || "").trim();
    const speakLanguage  = (req.body.speakLanguage  || "").trim();
    if (!answerLanguage || !speakLanguage) {
      return res.status(400).json({ error: "missing_language" });
    }
    if (!req.file || req.file.size < 5000) {
      return res.status(400).json({ error: "audio_too_short" });
    }

    // 1) Speech → Text (hint language if known)
    const stt = await openai.audio.transcriptions.create({
      file: await toFile(req.file.buffer, "speech.webm", { type: "audio/webm" }),
      model: "gpt-4o-transcribe",        // fallback: "whisper-1"
      language: ISO[speakLanguage] || undefined
    });
    const userText = (stt.text || "").trim();

    // 2) Tutor reasoning (default system message every time)
    const systemPrompt =
      `You are a ${answerLanguage} kids e-learning helper for Indian kids. ` +
      `Use very simple words, short sentences, kid-safe examples, and be warm. ` +
      `Clarify the kid's doubt based on what they asked. Always answer in ${answerLanguage}.`;

    const response = await openai.responses.create({
      model: "gpt-5",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ]
    });
    const assistantText = (response.output_text || "").trim();

    // 3) Text → Speech
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: assistantText,
      format: "mp3"
    });

    const base64Audio = Buffer.from(await speech.arrayBuffer()).toString("base64");
    res.json({ transcript: userText, text: assistantText, audioBase64: base64Audio });

  } catch (err) {
    const msg = (err?.error?.message || err?.message || "").toLowerCase();
    if (msg.includes("shorter than")) return res.status(400).json({ error: "audio_too_short" });
    console.error(err);
    res.status(500).json({ error: "processing_failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
