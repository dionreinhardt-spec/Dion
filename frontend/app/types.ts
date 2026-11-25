export type Flow = {
  seconds: number;
  trades: number;
  buys: number;
  sells: number;
  unique_buyers: number;
  unique_sellers: number;
  gross_buy_usd: number | null;
  gross_sell_usd: number | null;
  net_flow_usd: number | null;
  priced_fraction: number;
  max_wallet_volume_share: number;
  roundtrip_volume_share: number;
  buy_sell_ratio: number | null;
};
export type Token = {
  token: string;
  chain: string;
  symbol: string;
  name: string;
  venue: string | null;
  price_usd: number | null;
  market: {
    price_usd: number;
    market_cap: number | null;
    fdv: number | null;
    liquidity_usd: number;
    volume_5m: number | null;
    dex: string;
    received_at: number;
    source: string;
  } | null;
  security: {
    blockers: string[];
    warnings: string[];
    token_program: string;
    largest_observed_owner_share: number | null;
    extensions: string[];
    checked_at: number;
  } | null;
  windows: Record<string, Flow>;
  window_coverage?: Record<string, { observed_seconds: number; complete: boolean }>;
  score: number;
  confidence: number;
  risk_score: number;
  status: string;
  contributions: Record<string, number>;
  features: Record<string, number | null>;
  inflow_score: number;
  positives: string[];
  warnings: string[];
  blockers: string[];
  trade_age_s: number | null;
  metadata_age_s: number | null;
  chain_latency_s: number | null;
  data_completeness_pct: number;
  last_event_at: number | null;
  evaluated_at: number;
  observed_seconds: number;
  plan: {
    allowed: boolean;
    max_notional_usd: number;
    risk_budget_usd: number;
    entry_zone: number[] | null;
    stop_price: number | null;
    take_profit: number[];
    reasons: string[];
    fee_bps_per_side: number;
    slippage_bps_base: number;
    priority_fee_usd_per_side: number;
  };
  axiom_url: string;
};
export type Journal = {
  id: string;
  side: string;
  token: string;
  timestamp: number;
  fill_price: number;
  fee_usd: number;
  notional_usd: number;
  realized_pnl_usd?: number;
  realized_return?: number;
  reason?: string;
};
export type Snapshot = {
  server_time: number;
  version: string;
  mode: string;
  scanner: Token[];
  watchlist: string[];
  launches: {
    token: string;
    event: string;
    timestamp: number;
    symbol: string;
    signature: string;
  }[];
  portfolio: {
    cash_usd: number;
    equity_usd: number;
    initial_cash_usd: number;
    exposure_usd: number;
    net_pnl_usd: number;
    realized_pnl_usd: number;
    kill_switch: boolean;
    breaker: string | null;
    journal: Journal[];
    positions: {
      id: string;
      token: string;
      symbol: string;
      entry_price: number;
      quantity: number;
      mark: number;
      mark_stale: boolean;
      return_pct: number;
      unrealized_pnl_usd: number;
      stop_price: number;
      exit_warning: string | null;
    }[];
  };
  system: {
    solana: {
      connected: boolean;
      last_message_at: number | null;
      subscriptions: number;
      reconnects: number;
      dropped: number;
      decode_errors: number;
      unsupported_quote: number;
      candidate_limit_skipped: number;
    };
    robinhood: { state: string };
    queue_depth: number;
    cache: string;
    last_tick_at: number | null;
    evaluation_ms: number | null;
    provider_calls: Record<string, number>;
    provider_errors: Record<string, number>;
    costs: {
      estimated_rpc_variable_usd: number;
      configured_fixed_monthly_usd: number;
    };
    errors: { component: string; error: string; at: number }[];
  };
  wallets: {
    wallet: string;
    observed_realized_pnl_usd: number;
    closed_lot_matches: number;
    win_rate: number;
    median_return: number;
    profit_factor: number | null;
    scope: string;
  }[];
  social: {
    status: Record<string, string | null>;
    trends: {
      category: string;
      mentions_10m: number;
      distinct_accounts: number;
      growth_ratio: number | null;
      contracts: string[];
    }[];
    recent: {
      id: string;
      platform: string;
      author: string;
      text: string;
      timestamp: number;
      contracts: string[];
    }[];
  };
  capabilities: Record<string, string>;
};
