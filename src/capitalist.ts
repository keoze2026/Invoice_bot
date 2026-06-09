import axios, { AxiosInstance } from 'axios';
import { Agent } from 'https';
import { createHmac } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Reuse TCP/TLS connections across requests so we don't pay a fresh handshake
// (multiple round-trips) on every order. Node 19+ enables this on the global
// agent already, but an explicit agent guarantees it regardless of runtime.
const keepAliveAgent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 64 });

export interface CreateOrderInput {
  amount: number;
  currency: string;
  description: string;
  number?: string;
  optEmail?: string;
  optClientId?: string;
}

export interface CapitalistOrder {
  number: string;
  merchant: number;
  amount: number;
  currency: string;
  description: string;
  status: string;
  statusLocalized?: string;
  date: number;
  email: string | null;
  paid: boolean;
  refunded: boolean;
  chargedBack: boolean;
  paymentUrl: string;
  convertedAmount: number | null;
  convertedCurrency: string | null;
}

interface CreateOrderResponse {
  order?: CapitalistOrder;
  errors?: Record<string, string>;
}

export class CapitalistError extends Error {
  constructor(message: string, public readonly fields?: Record<string, string>) {
    super(message);
    this.name = 'CapitalistError';
  }
}

export class CapitalistClient {
  private readonly http: AxiosInstance;

  constructor(
    private readonly merchantId: number,
    private readonly secret: string,
    baseUrl = 'https://api.capitalist.net',
  ) {
    if (!merchantId) throw new Error('CAPITALIST_MERCHANT_ID is required');
    if (!secret) throw new Error('CAPITALIST_MERCHANT_SECRET is required');

    this.http = axios.create({
      baseURL: baseUrl,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: 15_000,
      httpsAgent: keepAliveAgent,
    });
  }

  async createOrder(input: CreateOrderInput): Promise<CapitalistOrder> {
    const payload: Record<string, string | number> = {
      merchantid: this.merchantId,
      number: input.number ?? generateOrderNumber(),
      amount: formatAmount(input.amount),
      currency: input.currency,
      description: input.description,
    };

    if (input.optEmail) payload.opt_email = input.optEmail;
    if (input.optClientId) payload.opt_client_id = input.optClientId;

    payload.sign = sign(payload, this.secret);

    const { data } = await this.http.post<CreateOrderResponse>(
      '/merchant/payGate/createorder',
      payload,
      { validateStatus: () => true },
    );

    if (data.errors || !data.order) {
      const errs = data.errors ?? { error: 'Unknown error from the payment provider' };
      const message = Object.entries(errs)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      throw new CapitalistError(message, errs);
    }

    return data.order;
  }
}

// Capitalist signature: HMAC-MD5 of values (sorted by key, joined with ":") using the merchant secret.
// Reference (PHP): unset($data['sign']); ksort($data, SORT_STRING); hash_hmac('md5', implode(':', $data), $secret)
export function sign(params: Record<string, string | number>, secret: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort();
  const str = keys.map((k) => String(params[k])).join(':');
  return createHmac('md5', secret).update(str).digest('hex');
}

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number');
  }
  // Capitalist accepts up to 2 decimals for USD/EUR/RUR/USDT/USDC and 8 for BTC.
  // Two decimals covers the documented USDT case; trim trailing zeros for cleanliness.
  return amount
    .toFixed(8)
    .replace(/\.?0+$/, '');
}

// Daily-resetting sequential order numbers in the format YYMMDD-NNN (e.g. 260609-001).
// The counter persists across restarts via a JSON file in the project root.
const COUNTER_FILE = join(__dirname, '..', 'order-counter.json');

interface CounterState {
  date: string;
  count: number;
}

let counterState: CounterState = loadCounter();

function loadCounter(): CounterState {
  if (!existsSync(COUNTER_FILE)) return { date: '', count: 0 };
  try {
    const parsed = JSON.parse(readFileSync(COUNTER_FILE, 'utf-8'));
    if (typeof parsed?.date === 'string' && typeof parsed?.count === 'number') {
      return { date: parsed.date, count: parsed.count };
    }
  } catch (err) {
    console.warn('Could not read order counter, starting fresh:', err);
  }
  return { date: '', count: 0 };
}

function saveCounter(state: CounterState): void {
  try {
    writeFileSync(COUNTER_FILE, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not persist order counter:', err);
  }
}

// Day rolls over at midnight America/New_York (handles EST/EDT automatically).
const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: '2-digit',
  month: '2-digit',
  day: '2-digit',
});

function todayYYMMDD(): string {
  const parts = DATE_FORMATTER.formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

function generateOrderNumber(): string {
  const today = todayYYMMDD();
  if (counterState.date !== today) {
    counterState = { date: today, count: 0 };
  }
  counterState.count += 1;
  saveCounter(counterState);
  return `${today}-${counterState.count.toString().padStart(3, '0')}`;
}
