require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const FOLDER_ID = '1iDCBiT8AZKOrh-BDosxwchZv7xbzz76S';

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
      requestBody: {
        name: filename,
        mimeType: 'application/vnd.google-apps.document',
        parents: [FOLDER_ID]
      },
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
      system: 'You are Basquiat, a helpful personal assistant for James. Help him with work emails, scheduling, newsletters, and daily tasks. Be concise and friendly. When James asks to save something, include SAVE_TO_DRIVE:filename at the end of your response.',
      messages: conversations[chatId]
    });

    let reply = response.content[0].text;

    if (reply.includes('SAVE_TO_DRIVE:')) {
      const parts = reply.split('SAVE_TO_DRIVE:');
      const contentToSave = parts[0].trim();
      const filename = parts[1].trim();
      bot.sendMessage(chatId, 'Saving to Google Drive...');
      const link = await saveToGoogleDrive(contentToSave, filename);
      reply = contentToSave + (link ? '\n\nSaved to Drive: ' + link : '\n\nCould not save to Drive.');
    }

    conversations[chatId].push({ role: 'assistant', content: reply });
    bot.sendMessage(chatId, reply);
  } catch (error) {
    bot.sendMessage(chatId, 'Sorry, something went wrong. Try again in a moment.');
    console.error(error);
  }
});

console.log('Basquiat is running with Google Drive support...');
