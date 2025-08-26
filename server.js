import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const app = express();
const upload = multer({ dest: "uploads/" });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// serve the static index.html
app.use(express.static("."));

// 1) receive audio -> STT
// 2) run reasoning/translation with Responses API
// 3) synthesize voice -> return playable URL
app.post("/api/ask", upload.single("audio"), async (req, res) => {
  try {
    const targetLanguage = req.body.targetLanguage || "English";

    // ---- Speech to Text (gpt-4o-transcribe or whisper-1)
    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-transcribe",          // fallback: "whisper-1"
      // language: "auto"                   // auto-detect
    });
    const userText = stt.text;

    // ---- Reasoning + language control (Responses API)
    const response = await openai.responses.create({
      model: "gpt-5", // or a cost-efficient model you prefer
      input: [
        {
          role: "system",
          content:
            `You are a friendly kids tutor. Use simple words, short sentences, and examples. ` +
            `Always answer in ${targetLanguage}. Keep it safe and age-appropriate.`
        },
        { role: "user", content: userText }
      ]
    });

    const assistantText = response.output_text;

    // ---- Text to Speech (gpt-4o-mini-tts)
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",           // try: verse, aria, breeze, coral, etc.
      input: assistantText,
      format: "mp3"
    });

    // write mp3 to a temp file and return a URL
    const outPath = path.join(__dirname, "tmp_" + Date.now() + ".mp3");
    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outPath, buffer);

    res.json({
      transcript: userText,
      text: assistantText,
      audioUrl: "/" + path.basename(outPath)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "processing_failed" });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// serve generated mp3s
app.use(express.static(__dirname));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on http://localhost:" + port));
