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

// Detect company tag from text (b84 or wb)
function detectCompany(text) {
                    if (!text) return null;
                    const lower = text.toLowerCase();
                    if (lower.includes('b84')) return 'b84';
                    if (lower.includes('wb') || lower.includes('w&b') || lower.includes('wall') || lower.includes('broad')) return 'wb';
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
// Notion external image blocks require a real HTTP/HTTPS URL, not base64
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

               // Handle company selection for a pending receipt
               if (pendingReceipts[chatId] && msg.text) {
                                           const company = detectCompany(msg.text);
                                           if (company) {
                                                                               const { fileUrl, imageData, caption } = pendingReceipts[chatId];
                                                                               pendingReceipts[chatId] = null;
                                                                               await processReceiptWithCompany(chatId, fileUrl, imageData, caption, company);
                                                                               return;
                                           } else {
                                                                               bot.sendMessage(chatId, 'Please reply with b84 (Blue 84) or wb (Wall & Broad).');
                                                                               return;
                                           }
               }

               if (!conversations[chatId]) conversations[chatId] = [];

               let userMessage;
                    let company = null;

               if (msg.photo) {
                                           // Handle photo messages
                            const photo = msg.photo[msg.photo.length - 1];
                                           const caption = msg.caption || '';
                                           company = detectCompany(caption);
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
                                           company = detectCompany(userMessage);
               } else {
                                           bot.sendMessage(chatId, 'Sorry, I can only handle text messages and photos right now.');
                                           return;
               }

               conversations[chatId].push({ role: 'user', content: userMessage });

               try {
                                           const systemPrompt = company
                                                   ? `You are Basquiat, a helpful personal assistant for James. Help him with work emails, scheduling, newsletters, and daily tasks. Be concise and friendly. This message is tagged for ${PAGE_IDS[company].label}. When James asks to save something, include SAVE_TO_NOTION:filename at the end of your response.`
                                                                               : `You are Basquiat, a helpful personal assistant for James. Help him with work emails, scheduling, newsletters, and daily tasks. Be concise and friendly. When James asks to save something, include SAVE_TO_NOTION:filename at the end of your response.`;

                            const response = await client.messages.create({
                                                                model: 'claude-sonnet-4-20250514',
                                                                max_tokens: 1024,
                                                                system: systemPrompt,
                                                                messages: conversations[chatId]
                            });

                            let reply = response.content[0].text;

                            if (reply.includes('SAVE_TO_NOTION:') && company) {
                                                                const parts = reply.split('SAVE_TO_NOTION:');
                                                                const contentToSave = parts[0].trim();
                                                                const filename = parts[1].trim();
                                                                bot.sendMessage(chatId, `Saving to ${PAGE_IDS[company].label} Expense Reports...`);
                                                                const link = await saveExpenseReport(contentToSave, filename, company);
                                                                reply = contentToSave + (link ? `\n\nSaved to ${PAGE_IDS[company].label}: ` + link : '\n\nCould not save to Notion.');
                            } else if (reply.includes('SAVE_TO_NOTION:') && !company) {
                                                                reply = reply.split('SAVE_TO_NOTION:')[0].trim() + '\n\n(Add b84 or wb to your message so I know which company to save this under.)';
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
