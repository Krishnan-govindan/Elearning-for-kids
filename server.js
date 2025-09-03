// server_updated.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import admin from 'firebase-admin';

/*
 * This server is an updated version of the original kid-speak-learn API.
 * It supports both voice and text inputs, verifies Firebase ID tokens,
 * and stores chat history in Firestore. The client sends a `uid` and
 * includes the Firebase ID token in the Authorization header. The
 * server verifies the token, ensures the uid matches, then processes
 * the request. It performs speech-to-text (if audio is provided),
 * generates an assistant response with OpenAI, converts it to speech,
 * and persists the turn to Firestore.
 */

// Initialize Firebase Admin using service account JSON provided via env
let adminApp;
try {
  const adminJson = process.env.FIREBASE_ADMIN_JSON ? JSON.parse(process.env.FIREBASE_ADMIN_JSON) : null;
  if (adminJson) {
    adminApp = admin.initializeApp({ credential: admin.credential.cert(adminJson) });
  }
} catch (e) {
  console.error('Failed to initialize Firebase Admin:', e);
}

const app = express();

const STT_MODEL = process.env.STT_MODEL || 'whisper-1';
const CLEAN_TRANSCRIPT = String(process.env.CLEAN_TRANSCRIPT || 'false').toLowerCase() === 'true';

app.use(cors({
  origin: [
    'https://india-therapist-chatbot.onrender.com',
    'https://krishnan-govindan.github.io'
  ],
  methods: ['GET', 'POST']
}));

const upload = multer({ storage: multer.memoryStorage() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static('.'));
// Needed to parse JSON bodies for text-only requests
app.use(express.json());

// Middleware to verify Firebase ID token (if provided)
async function verifyFirebaseToken(req, res, next) {
  const authHdr = req.headers.authorization || '';
  const tokenMatch = authHdr.match(/^Bearer\s+(.*)$/i);
  if (tokenMatch && adminApp) {
    const idToken = tokenMatch[1];
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.firebaseUser = decoded;
    } catch (e) {
      console.warn('Invalid Firebase token:', e?.message || e);
      req.firebaseUser = null;
    }
  } else {
    req.firebaseUser = null;
  }
  next();
}
app.use(verifyFirebaseToken);

// Map of language names to ISO codes for Whisper
const ISO = {
  English:'en', Hindi:'hi', Tamil:'ta', Telugu:'te', Kannada:'kn',
  Malayalam:'ml', Marathi:'mr', Gujarati:'gu', Bengali:'bn',
  Punjabi:'pa', Panjabi:'pa'
};

app.post('/api/ask', upload.single('audio'), async (req, res) => {
  try {
    // Extract fields; support both multipart/form-data and JSON
    const body = req.body || {};
    const answerLanguage = (body.answerLanguage || '').trim();
    const speakLanguage  = (body.speakLanguage  || '').trim();
    const conversationId = (body.conversationId || '').trim();
    const uid            = (body.uid || '').trim();
    // History may be provided as JSON array or stringified JSON
    let clientHistory = [];
    if (body.history) {
      try {
        clientHistory = typeof body.history === 'string' ? JSON.parse(body.history) : body.history;
        if (!Array.isArray(clientHistory)) clientHistory = [];
      } catch {
        clientHistory = [];
      }
    }
    // Validate required fields
    if (!conversationId) {
      return res.status(400).json({ error: 'missing_conversation', message: 'No conversationId provided.' });
    }
    if (!answerLanguage || !speakLanguage) {
      return res.status(400).json({ error: 'missing_language', message: 'Please select both Speaking and Answer languages.' });
    }
    // If id token is provided ensure uid matches decoded user
    if (uid && req.firebaseUser && req.firebaseUser.uid && uid !== req.firebaseUser.uid) {
      return res.status(401).json({ error: 'unauthenticated', message: 'UID does not match authenticated user.' });
    }
    // Determine user text: from audio or from text field
    let userText = '';
    if (req.file && req.file.buffer && req.file.size >= 5000) {
      // Speech-to-text
      const stt = await openai.audio.transcriptions.create({
        file: await toFile(req.file.buffer, 'speech.webm', { type: 'audio/webm' }),
        model: STT_MODEL,
        language: ISO[speakLanguage] || undefined,
        prompt: `This is a child speaking ${speakLanguage} about school topics. Keep output in ${speakLanguage}.`
      });
      userText = (stt.text || '').trim();
    } else if (body.text && typeof body.text === 'string' && body.text.trim()) {
      userText = body.text.trim();
    } else {
      return res.status(400).json({ error: 'no_input', message: 'No valid audio or text provided.' });
    }
    // Optional cleanup using GPT to fix transcription errors
    if (CLEAN_TRANSCRIPT && userText) {
      const cleaned = await openai.responses.create({
        model: 'gpt-5',
        input: [
          { role: 'system', content: `Fix obvious transcription errors in ${speakLanguage} child speech. Return only the corrected text.` },
          { role: 'user', content: userText }
        ]
      });
      userText = (cleaned.output_text || userText).trim();
    }
    // Prepare safe history: last 6 turns (≈ 12 messages)
    const MAX_TURNS = 6;
    const safeHistory = clientHistory.slice(-MAX_TURNS * 2);
    // Compose system prompt and messages
    const systemPrompt =
      `You are a ${answerLanguage} kids e-learning helper for Indian kids. ` +
      `This API key is for child-friendly education. Use very simple words, short sentences, warm tone. ` +
      `Use the chat history to keep continuity and clarify doubts with tiny examples. ` +
      `Avoid adult/harmful content. Always answer in ${answerLanguage}.`;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...safeHistory,
      { role: 'user', content: userText }
    ];
    // Generate assistant text
    const resp = await openai.responses.create({ model: 'gpt-5', input: messages });
    const assistantText = (resp.output_text || '').trim();
    // Text-to-speech
    const speech = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: assistantText,
      format: 'mp3'
    });
    const base64Audio = Buffer.from(await speech.arrayBuffer()).toString('base64');
    // Persist the turn to Firestore (if admin initialized and uid provided)
    if (adminApp && uid) {
      try {
        const db = admin.firestore();
        const chatRef = db.collection('users').doc(uid).collection('chats').doc(conversationId);
        // ensure chat document exists; update updatedAt and maybe title
        await chatRef.set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        // Save user message
        await chatRef.collection('messages').add({
          role: 'user',
          content: userText,
          speakLanguage,
          answerLanguage,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        // Save assistant message
        await chatRef.collection('messages').add({
          role: 'assistant',
          content: assistantText,
          speakLanguage,
          answerLanguage,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        console.error('Failed to write history to Firestore:', e);
      }
    }
    // Respond
    res.json({
      conversationId,
      transcript: userText,
      text: assistantText,
      audioBase64: base64Audio
    });
  } catch (err) {
    const msg = (err?.error?.message || err?.message || '').toLowerCase();
    if (msg.includes('shorter than') || msg.includes('too short')) {
      return res.status(400).json({ error: 'audio_too_short', message: 'Audio too short. Please record at least 1 second.' });
    }
    if (msg.includes('invalid') && msg.includes('language')) {
      return res.status(400).json({ error: 'invalid_language', message: 'Unsupported language code.' });
    }
    console.error('API error:', err);
    return res.status(500).json({ error: 'processing_failed', message: 'Something went wrong while processing input.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}. STT_MODEL=${STT_MODEL} CLEAN_TRANSCRIPT=${CLEAN_TRANSCRIPT}`));
