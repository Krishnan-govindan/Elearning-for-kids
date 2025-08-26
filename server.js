import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

const app = express();

// tighten origins if you have a fixed domain
app.use(cors({
  origin: [
    "https://india-therapist-chatbot.onrender.com", // your Render URL
    "http://localhost:3000"
  ],
  methods: ["GET","POST"],
}));

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(express.static("public"));

app.post("/api/ask", upload.single("audio"), async (req, res) => {
  try {
    const targetLanguage = (req.body.targetLanguage || "English").trim();

    if (!req.file) {
      return res.status(400).json({ error: "no_audio" });
    }

    // ---- 1) Speech to text
    const stt = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], "speech.webm", { type: "audio/webm" }),
      model: "gpt-4o-transcribe" // fallback: "whisper-1"
      // language: "auto"
    });
    const userText = (stt.text || "").trim();

    // ---- 2) Tutor answer (kid-safe)
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
      voice: "alloy",      // try: aria, breeze, coral, verse...
      input: assistantText,
      format: "mp3"
    });

    const arrayBuf = await speech.arrayBuffer();
    const base64Audio = Buffer.from(arrayBuf).toString("base64");

    res.json({
      transcript: userText,
      text: assistantText,
      audioBase64: base64Audio // front-end will set data URL
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "processing_failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
