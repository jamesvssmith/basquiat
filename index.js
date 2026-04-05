require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const conversations = {};

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  conversations[chatId].push({ role: 'user', content: userMessage });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: 'You are Basquiat, a helpful personal assistant for James. Help him with work emails, scheduling, newsletters, and daily tasks. Be concise and friendly.',
      messages: conversations[chatId]
    });

    const reply = response.content[0].text;
    conversations[chatId].push({ role: 'assistant', content: reply });
    bot.sendMessage(chatId, reply);
  } catch (error) {
    bot.sendMessage(chatId, 'Sorry, something went wrong. Try again in a moment.');
    console.error(error);
  }
});

console.log('Basquiat is running...');
