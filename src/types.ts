export type Timeframe = '1m' | '2m' | '3m' | '5m' | '10m' | '15m' | '30m' | '1h' | '1d';
export type ContractState = 'UNSEEN' | 'ACTIVE' | 'STICKY' | 'EXPIRED';
export type GapType = 'interpolated' | 'stale' | null;
export type OptionType = 'call' | 'put';
export type InstrumentType = 'index' | 'future' | 'etf' | 'call' | 'put';

export interface Bar {
  symbol: string;
  timeframe: Timeframe;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  synthetic: boolean;
  gapType: GapType;
  indicators: Record<string, number | null>;
}

export interface Contract {
  symbol: string;
  type: InstrumentType;
  underlying: string;
  strike: number;
  expiry: string;
  state: ContractState;
  firstSeen: number;
  lastBarTs: number;
  createdAt: number;
}

export interface OHLCVRaw {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Rolling circular buffer state for incremental WMA computation */
export interface WMAState {
  buf: number[];   // circular buffer of last `period` values
  pos: number;     // write position in the buffer
  filled: boolean; // true once buffer has been fully populated
  period: number;
}

/** Per-period incremental HMA state: WMA(half), WMA(full), then WMA(sqrt) over the diff series */
export interface HMAState {
  wmaHalf:  WMAState; // WMA(floor(period/2)) applied to closes
  wmaFull:  WMAState; // WMA(period) applied to closes
  wmaSqrt:  WMAState; // WMA(round(sqrt(period))) applied to the (2*wmaHalf - wmaFull) series
}

export interface IndicatorState {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  typicalPrices: number[];
  cumulativeTPV: number;
  cumulativeVol: number;
  emaState: Record<number, number | null>;
  macdState: { fastEma: number | null; slowEma: number | null; signalEma: number | null };
  atrState: number | null;
  adxState: { plusDM: number | null; minusDM: number | null; tr: number | null; adx: number | null };
  hmaState: Record<number, HMAState>; // keyed by HMA period
}

export interface ChainContract {
  symbol: string;
  type: OptionType;
  strike: number;
  expiry: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface ScreenerSnapshot {
  symbol: string;
  close: number;
  change: number;
  rsi: number | null;
  macd: number | null;
  ema50: number | null;
  volatilityD: number | null;
  recommendation: number | null;
  ts: number;
}

export interface ServiceStatus {
  uptime: number;
  trackedContracts: number;
  activeContracts: number;
  stickyContracts: number;
  dbSizeMb: number;
  currentMode: 'overnight' | 'preopen' | 'rth' | 'weekend';
  lastSpxPrice: number | null;
  lastUpdate: number;
}
