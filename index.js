require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;

// Company-specific Notion page IDs
const PAGE_IDS = {
          b84: {
                            expenseReports: process.env.B84_EXPENSE_REPORTS_PAGE_ID,
                            receiptImages: process.env.B84_RECEIPT_IMAGES_PAGE_ID,
                            label: 'Blue 84'
          },
          wb: {
                            expenseReports: process.env.WB_EXPENSE_REPORTS_PAGE_ID,
                            receiptImages: process.env.WB_RECEIPT_IMAGES_PAGE_ID,
                            label: 'Wall & Broad Supply Co.'
          }
};

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const notion = new Client({ auth: NOTION_TOKEN });

// Detect company tag from caption text only.
// Uses word-boundary regex so 'wb' or 'b84' must appear as standalone tokens,
// not embedded inside other words. Only fires on photo captions, never on
// regular conversation messages.
function detectCompany(text) {
          if (!text) return null;
          const lower = text.toLowerCase();
          // Match only as whole words / standalone tags
        if (/\bb84\b/.test(lower)) return 'b84';
          if (/\bwb\b/.test(lower) || /w&b/.test(lower)) return 'wb';
          return null;
}

async function saveExpenseReport(content, filename, company) {
          const pages = PAGE_IDS[company];
          try {
                            const chunks = [];
                            for (let i = 0; i < content.length; i += 2000) {
                                                      chunks.push(content.slice(i, i + 2000));
                            }
                            const page = await notion.pages.create({
                                                      parent: { page_id: pages.expenseReports },
                                                      properties: {
                                                                                        title: { title: [{ text: { content: filename } }] }
                                                      },
                                                      children: chunks.map(chunk => ({
                                                                                        object: 'block',
                                                                                        type: 'paragraph',
                                                                                        paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] }
                                                      }))
                            });
                            return `https://notion.so/${page.id.replace(/-/g, '')}`;
          } catch (error) {
                            console.error('Notion expense report error:', error);
                            return null;
          }
}

// Save receipt image using the Telegram file URL (public HTTPS URL)
async function saveReceiptImage(fileUrl, filename, company) {
          const pages = PAGE_IDS[company];
          try {
                            const page = await notion.pages.create({
                                                      parent: { page_id: pages.receiptImages },
                                                      properties: {
                                                                                        title: { title: [{ text: { content: filename } }] }
                                                      },
                                                      children: [
                                                        {
                                                                                                  object: 'block',
                                                                                                  type: 'image',
                                                                                                  image: {
                                                                                                                                                    type: 'external',
                                                                                                                                                    external: { url: fileUrl }
                                                                                                    }
                                                        }
                                                                                ]
                            });
                            return `https://notion.so/${page.id.replace(/-/g, '')}`;
          } catch (error) {
                            console.error('Notion receipt image error:', error);
                            return null;
          }
}

async function fetchImageAsBase64(url) {
          return new Promise((resolve, reject) => {
                            https.get(url, (res) => {
                                                      const chunks = [];
                                                      res.on('data', chunk => chunks.push(chunk));
                                                      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
                                                      res.on('error', reject);
                            }).on('error', reject);
          });
}

// Store pending company selection: { fileUrl, imageData, caption }
const pendingReceipts = {};
const conversations = {};

bot.on('message', async (msg) => {
          const chatId = msg.chat.id;

               // Handle /reset command
               if (msg.text && msg.text.trim() === '/reset') {
                                 conversations[chatId] = [];
                                 pendingReceipts[chatId] = null;
                                 bot.sendMessage(chatId, 'Conversation cleared. Starting fresh!');
                                 return;
               }

               // Handle company selection for a PENDING receipt (only if we're waiting for one)
               if (pendingReceipts[chatId] && msg.text) {
                                 const trimmed = msg.text.trim().toLowerCase();
                                 // Only accept exact tag replies: b84 or wb (and w&b)
                  let company = null;
                                 if (trimmed === 'b84' || trimmed === '#b84') company = 'b84';
                                 else if (trimmed === 'wb' || trimmed === 'w&b' || trimmed === '#wb') company = 'wb';

                  if (company) {
                                            const { fileUrl, imageData, caption } = pendingReceipts[chatId];
                                            pendingReceipts[chatId] = null;
                                            await processReceiptWithCompany(chatId, fileUrl, imageData, caption, company);
                                            return;
                  } else {
                                            // Not a valid tag — clear the pending receipt and treat as normal message
                                         pendingReceipts[chatId] = null;
                                            // Fall through to normal conversation handling below
                  }
               }

               if (!conversations[chatId]) conversations[chatId] = [];

               let userMessage;

               if (msg.photo) {
                                 // Handle photo messages — only photos trigger receipt flow
                  const photo = msg.photo[msg.photo.length - 1];
                                 const caption = msg.caption || '';
                                 const company = detectCompany(caption);
                                 try {
                                                           const fileInfo = await bot.getFile(photo.file_id);
                                                           const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
                                                           const imageData = await fetchImageAsBase64(fileUrl);

                                         if (!company) {
                                                                           // Ask which company before processing
                                                                   pendingReceipts[chatId] = { fileUrl, imageData, caption };
                                                                           bot.sendMessage(chatId, 'Got the receipt! Which company is this for?\nReply b84 for Blue 84 or wb for Wall & Broad.');
                                                                           return;
                                         }

                                         await processReceiptWithCompany(chatId, fileUrl, imageData, caption, company);
                                                           return;
                                 } catch (err) {
                                                           console.error('Photo fetch error:', err);
                                                           bot.sendMessage(chatId, 'Sorry, I could not process that image.');
                                                           return;
                                 }
               } else if (msg.text) {
                                 userMessage = msg.text;
               } else {
                                 bot.sendMessage(chatId, 'Sorry, I can only handle text messages and photos right now.');
                                 return;
               }

               // Normal conversation — no company routing for plain text messages
               conversations[chatId].push({ role: 'user', content: userMessage });

               try {
                                 const response = await client.messages.create({
                                                           model: 'claude-sonnet-4-20250514',
                                                           max_tokens: 1024,
                                                           system: `You are Basquiat, a helpful personal assistant for James. Help him with work emails, scheduling, newsletters, and daily tasks. Be concise and friendly. When James asks to save something, include SAVE_TO_NOTION:filename at the end of your response.`,
                                                           messages: conversations[chatId]
                                 });

                  let reply = response.content[0].text;

                  if (reply.includes('SAVE_TO_NOTION:')) {
                                            const parts = reply.split('SAVE_TO_NOTION:');
                                            const contentToSave = parts[0].trim();
                                            const filename = parts[1].trim();
                                            bot.sendMessage(chatId, 'Saving to Notion...');
                                            // For plain text saves, use the general NOTION_PAGE_ID if set, otherwise skip
                                         reply = contentToSave + '\n\n(Note: plain text saves need a NOTION_PAGE_ID — use a receipt photo with b84/wb tag for expense saving.)';
                  }

                  conversations[chatId].push({ role: 'assistant', content: reply });
                                 bot.sendMessage(chatId, reply);
               } catch (error) {
                                 bot.sendMessage(chatId, 'Sorry, something went wrong. Try again in a moment.');
                                 console.error(error);
               }
});

async function processReceiptWithCompany(chatId, fileUrl, imageData, caption, company) {
          const companyLabel = PAGE_IDS[company].label;
          bot.sendMessage(chatId, `Processing receipt for ${companyLabel}...`);

        try {
                          // Extract receipt details via Claude vision (uses base64)
                  const visionResponse = await client.messages.create({
                                            model: 'claude-sonnet-4-20250514',
                                            max_tokens: 1024,
                                            messages: [{
                                                                              role: 'user',
                                                                              content: [
                                                                                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
                                                                                { type: 'text', text: `Extract the receipt details from this image. Format the response as:\nVendor: [name]\nDate: [date]\nAmount: [total]\nItems: [brief description]\nCategory: [meal/fuel/supplies/travel/other]\n\nAdditional context: ${caption || 'none'}` }
                                                                                                                ]
                                            }]
                  });

                  const extractedText = visionResponse.content[0].text;

                  const vendorMatch = extractedText.match(/Vendor:\s*(.+)/i);
                          const dateMatch = extractedText.match(/Date:\s*(.+)/i);
                          const amountMatch = extractedText.match(/Amount:\s*(.+)/i);

                  const vendor = vendorMatch ? vendorMatch[1].trim() : 'receipt';
                          const date = dateMatch ? dateMatch[1].trim().replace(/\//g, '-') : new Date().toISOString().split('T')[0];
                          const amount = amountMatch ? amountMatch[1].trim() : '';
                          const filename = `${company.toUpperCase()}_${vendor}_${date}${amount ? '_' + amount.replace(/[$,]/g, '') : ''}`;

                  // Save extracted text to Expense Reports
                  const reportLink = await saveExpenseReport(extractedText, filename, company);

                  // Save image to Receipt Images using the Telegram file URL
                  const imageLink = await saveReceiptImage(fileUrl, filename, company);

                  let reply = `Receipt saved to ${companyLabel}!\n\n${extractedText}`;
                          if (reportLink) reply += `\n\nExpense Report: ${reportLink}`;
                          if (imageLink) reply += `\nReceipt Image: ${imageLink}`;

                  bot.sendMessage(chatId, reply);

                  // Add to conversation history as text
                  if (!conversations[chatId]) conversations[chatId] = [];
                          conversations[chatId].push({ role: 'user', content: `[Receipt photo for ${companyLabel}] ${caption || ''}` });
                          conversations[chatId].push({ role: 'assistant', content: reply });

        } catch (error) {
                          console.error('Receipt processing error:', error);
                          bot.sendMessage(chatId, 'Sorry, something went wrong processing that receipt.');
        }
}

console.log('Basquiat is running with company expense routing...');
