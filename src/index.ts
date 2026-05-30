import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { CapitalistClient, CapitalistError } from './capitalist';

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ADMIN_IDS = '',
  CAPITALIST_MERCHANT_ID,
  CAPITALIST_MERCHANT_SECRET,
  CAPITALIST_CURRENCY = 'USDTt',
  CAPITALIST_CURRENCY_DISPLAY,
  CAPITALIST_DEFAULT_DESCRIPTION = 'Telegram bot payment',
  CAPITALIST_API_URL = 'https://api.capitalist.net',
} = process.env;

const adminIds = new Set(
  TELEGRAM_ADMIN_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0),
);

if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!CAPITALIST_MERCHANT_ID) throw new Error('CAPITALIST_MERCHANT_ID is required');
if (!CAPITALIST_MERCHANT_SECRET) throw new Error('CAPITALIST_MERCHANT_SECRET is required');

const merchantId = Number(CAPITALIST_MERCHANT_ID);
if (!Number.isInteger(merchantId) || merchantId <= 0) {
  throw new Error('CAPITALIST_MERCHANT_ID must be a positive integer');
}

const currencyDisplay = CAPITALIST_CURRENCY_DISPLAY || CAPITALIST_CURRENCY;

const capitalist = new CapitalistClient(merchantId, CAPITALIST_MERCHANT_SECRET, CAPITALIST_API_URL);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

let isPaused = false;
const isAdmin = (userId?: number) => !!userId && adminIds.has(userId);

const WELCOME_MESSAGE = [
  `<b>Welcome${'${name}' /* placeholder, replaced per-user */}</b>`,
  '',
  `I generate payment links in ${'${currency}'} no login required`,
  '',
  '<b>How to use</b>',
  '<code>/pay &lt;amount&gt; [description]</code>',
  '',
  '<b>Examples</b>',
  '<code>/pay 10</code>',
  '<code>/pay 25.5 Pro plan upgrade</code>',
  '',
  'Type /help any time to see this again.',
].join('\n');

function renderWelcome(firstName?: string): string {
  const name = firstName ? `, ${escapeHtml(firstName)}` : '';
  return WELCOME_MESSAGE
    .replace('${name}', name)
    .replace('${currency}', escapeHtml(currencyDisplay));
}

bot.start(async (ctx) => {
  if (isPaused) {
    if (isAdmin(ctx.from?.id)) {
      isPaused = false;
      console.log(`Bot resumed by admin ${ctx.from?.id}`);
      await ctx.reply('Bot resumed. Invoices are enabled again.');
      return;
    }
    await ctx.reply('The bot is currently paused. Please try again later.');
    return;
  }
  await ctx.reply(renderWelcome(ctx.from?.first_name), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
});

bot.help((ctx) =>
  ctx.reply(renderWelcome(ctx.from?.first_name), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }),
);

bot.command('pay', async (ctx) => {
  if (isPaused) {
    await ctx.reply('The bot is currently paused. Please try again later.');
    return;
  }
  const raw = ctx.message.text.replace(/^\/pay(@\w+)?\s*/i, '').trim();
  if (!raw) {
    await ctx.reply('Usage: /pay <amount> [description]\nExample: /pay 10');
    return;
  }

  const [amountStr, ...descParts] = raw.split(/\s+/);
  const amount = Number(amountStr.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) {
    await ctx.reply(`"${amountStr}" is not a valid amount. Example: /pay 10`);
    return;
  }

  const description = descParts.join(' ').slice(0, 150) || CAPITALIST_DEFAULT_DESCRIPTION;

  try {
    const order = await capitalist.createOrder({
      amount,
      currency: CAPITALIST_CURRENCY,
      description,
      optClientId: String(ctx.from?.id ?? ''),
    });

    const status = order.statusLocalized || order.status;
    const message = [
      '<b>New invoice!</b>',
      '',
      `<b>UUID:</b> ${escapeHtml(order.number)}`,
      `<b>Status:</b> ${escapeHtml(status)}`,
      `<b>Amount:</b> ${formatAmountDisplay(order.amount)} ${escapeHtml(currencyDisplay)}`,
      `<b>Description:</b> ${escapeHtml(order.description)}`,
      `<b>Payment Link:</b> <a href="${escapeHtml(order.paymentUrl)}">${escapeHtml(order.paymentUrl)}</a>`,
    ].join('\n');

    await ctx.reply(message, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch (err) {
    if (err instanceof CapitalistError) {
      await ctx.reply(`The payment provider rejected the invoice:\n${err.message}`);
      return;
    }
    console.error('createOrder failed', err);
    await ctx.reply('Could not create the invoice. Please try again later.');
  }
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAmountDisplay(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toString();
}

bot.command('stop', async (ctx) => {
  const userId = ctx.from?.id;
  if (!isAdmin(userId)) {
    await ctx.reply('This command is restricted to bot admins.');
    return;
  }
  if (isPaused) {
    await ctx.reply('The bot is already paused. Send /start to resume.');
    return;
  }
  isPaused = true;
  console.log(`Bot paused by admin ${userId}`);
  await ctx.reply('Bot paused. Send /start to resume.');
});

bot.launch().then(() => console.log('Bot started'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
