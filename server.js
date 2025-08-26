import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();

// CORS — allow your Render app and GitHub Pages (or just allow all while testing)
app.use(cors({
  origin: [
    "https://india-therapist-chatbot.onrender.com",   // your Render app
    "https://krishnan-govindan.github.io"             // your GitHub Pages domain
  ],
  methods: ["GET", "POST"],
}));

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Serve static files from the repo root (your index.html is at root)
app.use(express.static("."));

app.post("/api/ask", upload.single("audio"), async (req, res) => {
  try {
    const targetLanguage = (req.body.targetLanguage || "English").trim();
    if (!req.file) return res.status(400).json({ error: "no_audio" });

    // ---- 1) Speech to text (use toFile instead of File(...) in Node)
    const stt = await openai.audio.transcriptions.create({
      file: await toFile(req.file.buffer, "speech.webm", { type: "audio/webm" }),
      model: "gpt-4o-transcribe" // fallback: "whisper-1"
    });
    const userText = (stt.text || "").trim();

    // ---- 2) Tutor answer
    const response = await openai.responses.create({
      model: "gpt-5",
      input: [
        {
          role: "system",
          content:
            `You are a friendly kids tutor. Use simple words, short sentences, and fun examples. ` +
            `Never include harmful content. Always answer in ${targetLanguage}.`
        },
        { role: "user", content: userText }
      ]
    });
    const assistantText = (response.output_text || "").trim();

    // ---- 3) Text to speech
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: assistantText,
      format: "mp3"
    });

    const arrayBuf = await speech.arrayBuffer();
    const base64Audio = Buffer.from(arrayBuf).toString("base64");

    res.json({
      transcript: userText,
      text: assistantText,
      audioBase64: base64Audio
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "processing_failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
