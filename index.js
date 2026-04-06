require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const notion = new Client({ auth: NOTION_TOKEN });

async function saveToNotion(content, filename) {
    try {
          const page = await notion.pages.create({
                  parent: { page_id: NOTION_PAGE_ID },
                  properties: {
                            title: {
                                        title: [{ text: { content: filename } }]
                            }
                  },
                  children: [
                    {
                                object: 'block',
                                type: 'paragraph',
                                paragraph: {
                                              rich_text: [{ type: 'text', text: { content: content } }]
                                }
                    }
                          ]
          });
          return `https://notion.so/${page.id.replace(/-/g, '')}`;
    } catch (error) {
          console.error('Notion error:', error);
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
                       system: 'You are Basquiat, a helpful personal assistant for James. Help him with work emails, scheduling, newsletters, and daily tasks. Be concise and friendly. When James asks to save something, include SAVE_TO_NOTION:filename at the end of your response.',
                       messages: conversations[chatId]
               });

      let reply = response.content[0].text;

      if (reply.includes('SAVE_TO_NOTION:')) {
              const parts = reply.split('SAVE_TO_NOTION:');
              const contentToSave = parts[0].trim();
              const filename = parts[1].trim();
              bot.sendMessage(chatId, 'Saving to Notion...');
              const link = await saveToNotion(contentToSave, filename);
              reply = contentToSave + (link ? '\n\nSaved to Notion: ' + link : '\n\nCould not save to Notion.');
      }

      conversations[chatId].push({ role: 'assistant', content: reply });
               bot.sendMessage(chatId, reply);
         } catch (error) {
               bot.sendMessage(chatId, 'Sorry, something went wrong. Try again in a moment.');
               console.error(error);
         }
});

console.log('Basquiat is running with Notion support...');
