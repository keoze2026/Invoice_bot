import 'dotenv/config';
import { randomBytes } from 'crypto';
import { Context, Telegraf } from 'telegraf';
import { CapitalistClient, CapitalistError, CapitalistOrder } from './capitalist';

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

const currencies = CAPITALIST_CURRENCY.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (currencies.length === 0) throw new Error('CAPITALIST_CURRENCY must list at least one code');

const CURRENCY_LABELS: Record<string, string> = {
  USDT: 'USDT (ERC-20)',
  USDTt: 'USDT (TRC-20)',
  USDTb: 'USDT (BEP-20)',
  USDC: 'USDC (ERC-20)',
  USDCb: 'USDC (BEP-20)',
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  USD: 'USD',
  EUR: 'EUR',
  RUR: 'RUR',
};

function currencyLabel(code: string): string {
  if (currencies.length === 1 && CAPITALIST_CURRENCY_DISPLAY) return CAPITALIST_CURRENCY_DISPLAY;
  return CURRENCY_LABELS[code] ?? code;
}

const capitalist = new CapitalistClient(merchantId, CAPITALIST_MERCHANT_SECRET, CAPITALIST_API_URL);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

let isPaused = false;
const isAdmin = (userId?: number) => !!userId && adminIds.has(userId);

interface PendingIntent {
  userId: number;
  amount: number;
  description: string;
  displayDescription: string;
  createdAt: number;
}
const pendingIntents = new Map<string, PendingIntent>();
const INTENT_TTL_MS = 10 * 60 * 1000;

function newIntent(
  userId: number,
  amount: number,
  description: string,
  displayDescription: string,
): string {
  const id = randomBytes(6).toString('hex');
  pendingIntents.set(id, {
    userId,
    amount,
    description,
    displayDescription,
    createdAt: Date.now(),
  });
  return id;
}

function takeIntent(id: string, userId: number): PendingIntent | null {
  const intent = pendingIntents.get(id);
  if (!intent) return null;
  if (intent.userId !== userId) return null;
  if (Date.now() - intent.createdAt > INTENT_TTL_MS) {
    pendingIntents.delete(id);
    return null;
  }
  pendingIntents.delete(id);
  return intent;
}

setInterval(() => {
  const cutoff = Date.now() - INTENT_TTL_MS;
  for (const [id, intent] of pendingIntents) {
    if (intent.createdAt < cutoff) pendingIntents.delete(id);
  }
}, 60_000).unref();

const methodsList = currencies.map(currencyLabel).join(', ');
const WELCOME_MESSAGE = [
  `<b>Welcome${'${name}' /* placeholder, replaced per-user */}</b>`,
  '',
  `I generate payment links — no login required. Accepted methods: ${'${methods}'}.`,
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
    .replace('${methods}', escapeHtml(methodsList));
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

  const userDescription = descParts.join(' ').slice(0, 150);
  const apiDescription = userDescription || CAPITALIST_DEFAULT_DESCRIPTION;
  const userId = ctx.from?.id;
  if (!userId) return;

  if (currencies.length === 1) {
    await createAndReply(ctx, currencies[0], amount, apiDescription, userDescription);
    return;
  }

  const intentId = newIntent(userId, amount, apiDescription, userDescription);
  await ctx.reply(
    `Choose a payment method for <b>${formatAmountDisplay(amount)}</b>:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: currencies.map((code) => [
          { text: currencyLabel(code), callback_data: `p:${intentId}:${code}` },
        ]),
      },
    },
  );
});

bot.on('callback_query', async (ctx) => {
  const data = (ctx.callbackQuery as { data?: string }).data;
  if (!data || !data.startsWith('p:')) {
    await ctx.answerCbQuery();
    return;
  }

  await ctx.answerCbQuery();

  if (isPaused) {
    await ctx.editMessageText('The bot is currently paused. Please try again later.');
    return;
  }

  const [, intentId, currency] = data.split(':');
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!currencies.includes(currency)) {
    await ctx.editMessageText('That payment method is no longer available. Send /pay again.');
    return;
  }

  const intent = takeIntent(intentId, userId);
  if (!intent) {
    await ctx.editMessageText('This payment request has expired. Send /pay again.');
    return;
  }

  try {
    const order = await capitalist.createOrder({
      amount: intent.amount,
      currency,
      description: intent.description,
      optClientId: String(userId),
    });
    await ctx.editMessageText(buildInvoiceMessage(order, currency, intent.displayDescription), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof CapitalistError) {
      await ctx.editMessageText(`The payment provider rejected the invoice:\n${err.message}`);
      return;
    }
    console.error('createOrder failed', err);
    await ctx.editMessageText('Could not create the invoice. Please try again later.');
  }
});

async function createAndReply(
  ctx: Context,
  currency: string,
  amount: number,
  description: string,
  displayDescription: string,
): Promise<void> {
  try {
    const order = await capitalist.createOrder({
      amount,
      currency,
      description,
      optClientId: String(ctx.from?.id ?? ''),
    });
    await ctx.reply(buildInvoiceMessage(order, currency, displayDescription), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof CapitalistError) {
      await ctx.reply(`The payment provider rejected the invoice:\n${err.message}`);
      return;
    }
    console.error('createOrder failed', err);
    await ctx.reply('Could not create the invoice. Please try again later.');
  }
}

function buildInvoiceMessage(
  order: CapitalistOrder,
  currency: string,
  displayDescription: string,
): string {
  const status = order.statusLocalized || order.status;
  return [
    '<b>New invoice!</b>',
    '',
    `<b>UUID:</b> ${escapeHtml(order.number)}`,
    `<b>Status:</b> ${escapeHtml(status)}`,
    `<b>Amount:</b> ${formatAmountDisplay(order.amount)} ${escapeHtml(currencyLabel(currency))}`,
    `<b>Description:</b> ${escapeHtml(displayDescription)}`,
    `<b>Payment Link:</b> <a href="${escapeHtml(order.paymentUrl)}">${escapeHtml(order.paymentUrl)}</a>`,
  ].join('\n');
}

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
