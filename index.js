require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

async function saveToGoogleDrive(content, filename) {
  try {
    const file = await drive.files.create({
      requestBody: { name: filename, mimeType: 'application/vnd.google-apps.document' },
      media: { mimeType: 'text/plain', body: content },
      fields: 'id, webViewLink',
    });
    return file.data.webViewLink;
  } catch (error) {
    console.error('Drive error:', error);
    return null;
  }
}

const conversations = {};

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: 'user', content: userMessage });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: 'You are Basquiat, a helpful personal assistant for James. Help him
