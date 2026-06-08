import axios, { AxiosInstance } from 'axios';
import { Agent } from 'https';
import { createHmac, randomInt } from 'crypto';

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

function generateOrderNumber(): string {
  // Format: tg-<epoch-seconds>-<8 random digits>. Digits + hyphen, well under 42 chars.
  const ts = Math.floor(Date.now() / 1000);
  const rand = randomInt(0, 100_000_000).toString().padStart(8, '0');
  return `tg-${ts}-${rand}`;
}
