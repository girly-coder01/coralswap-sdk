import { CoralSwapClient } from "@/client";
import { PRECISION } from "@/config";
import { RWAError, NetworkError } from "@/errors";

export interface RWAPrice {
  nav: number;
  yieldAPY: number;
  lastUpdated: number;
}

export interface RWASwapQuote {
  inputToken: string;
  outputToken: string;
  inputAmount: bigint;
  outputAmount: bigint;
  executionPrice: number;
  navAdjustedPrice: number;
  navInput: number;
  navOutput: number;
}

export interface RWAPoolAPY {
  pairAddress: string;
  swapFeeAPR: number;
  underlyingYieldAPY: number;
  totalAPY: number;
  breakdown: {
    feeRateBps: number;
    estimatedAnnualVolumeRatio: number;
  };
}

interface AssetConfig {
  symbol: string;
  yieldSymbol?: string;
  defaultYieldAPY: number;
}

interface CachedPrice {
  nav: number;
  yieldAPY: number;
  lastUpdated: number;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const REDSTONE_BASE_URL = "https://api.redstone.finance/prices";
const DEFAULT_ANNUAL_VOLUME_RATIO = 365;

const DEFAULT_ASSET_MAP: Record<string, AssetConfig> = {
  "deJTRSY": {
    symbol: "deJTRSY",
    defaultYieldAPY: 4.25,
  },
  "deJAAA": {
    symbol: "deJAAA",
    defaultYieldAPY: 6.50,
  },
};

export class RWAModule {
  private client: CoralSwapClient;
  private assetMap: Record<string, AssetConfig>;
  private cache: Map<string, CachedPrice> = new Map();
  private ttlMs: number;
  private annualVolumeRatio: number;

  constructor(
    client: CoralSwapClient,
    opts?: {
      assetMap?: Record<string, AssetConfig>;
      ttlMs?: number;
      annualVolumeRatio?: number;
    },
  ) {
    this.client = client;
    this.assetMap = opts?.assetMap ?? { ...DEFAULT_ASSET_MAP };
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.annualVolumeRatio = opts?.annualVolumeRatio ?? DEFAULT_ANNUAL_VOLUME_RATIO;
  }

  private getAssetConfig(address: string): AssetConfig {
    const config = this.assetMap[address];
    if (!config) {
      throw RWAError.UnsupportedAsset(address);
    }
    return config;
  }

  async getRWAPrice(centrifugeAssetAddress: string): Promise<RWAPrice> {
    const config = this.getAssetConfig(centrifugeAssetAddress);

    const cached = this.cache.get(centrifugeAssetAddress);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return {
        nav: cached.nav,
        yieldAPY: cached.yieldAPY,
        lastUpdated: cached.lastUpdated,
      };
    }

    const nav = await this.fetchRedStonePrice(config.symbol);
    let yieldAPY = config.defaultYieldAPY;

    if (config.yieldSymbol) {
      try {
        const yieldPrice = await this.fetchRedStonePrice(config.yieldSymbol);
        yieldAPY = yieldPrice.value;
      } catch {
        yieldAPY = config.defaultYieldAPY;
      }
    }

    const result: RWAPrice = {
      nav: nav.value,
      yieldAPY,
      lastUpdated: nav.timestamp,
    };

    this.cache.set(centrifugeAssetAddress, {
      nav: result.nav,
      yieldAPY: result.yieldAPY,
      lastUpdated: result.lastUpdated,
      fetchedAt: Date.now(),
    });

    return result;
  }

  private async getNAV(address: string): Promise<number> {
    if (!this.assetMap[address]) {
      return 1.0;
    }
    const price = await this.getRWAPrice(address);
    return price.nav;
  }

  async quoteRWASwap(
    fromToken: string,
    toToken: string,
    amount: bigint,
  ): Promise<RWASwapQuote> {
    const [navInput, navOutput] = await Promise.all([
      this.getNAV(fromToken),
      this.getNAV(toToken),
    ]);

    const scaledInput = BigInt(Math.round(navInput * Number(PRECISION.PRICE_SCALE)));
    const scaledOutput = BigInt(Math.round(navOutput * Number(PRECISION.PRICE_SCALE)));

    const outputAmount = (amount * scaledInput) / scaledOutput;

    const executionPrice =
      Number(outputAmount) / Number(amount);

    return {
      inputToken: fromToken,
      outputToken: toToken,
      inputAmount: amount,
      outputAmount,
      executionPrice,
      navAdjustedPrice: executionPrice,
      navInput,
      navOutput,
    };
  }

  async getRWAPoolAPY(pairAddress: string): Promise<RWAPoolAPY> {
    const pair = this.client.pair(pairAddress);
    const feeState = await pair.getFeeState();
    const tokens = await pair.getTokens();
    const reserves = await pair.getReserves();

    const feeRateBps = feeState.feeCurrent;

    const isToken0RWA = this.assetMap[tokens.token0] !== undefined;
    const isToken1RWA = this.assetMap[tokens.token1] !== undefined;

    let underlyingYieldAPY = 0;
    if (isToken0RWA) {
      const price = await this.getRWAPrice(tokens.token0);
      underlyingYieldAPY = price.yieldAPY;
    } else if (isToken1RWA) {
      const price = await this.getRWAPrice(tokens.token1);
      underlyingYieldAPY = price.yieldAPY;
    }

    const totalLiquidityUsd =
      isToken0RWA && isToken1RWA
        ? 0
        : isToken0RWA
          ? Number(reserves.reserve1)
          : Number(reserves.reserve0);

    if (totalLiquidityUsd > 0) {
      const feeRate = feeRateBps / 10_000;
      const annualVolumeUsd = totalLiquidityUsd * this.annualVolumeRatio;
      const swapFeeAPR = feeRate * this.annualVolumeRatio;
      const totalAPY = swapFeeAPR + underlyingYieldAPY;

      return {
        pairAddress,
        swapFeeAPR,
        underlyingYieldAPY,
        totalAPY,
        breakdown: {
          feeRateBps,
          estimatedAnnualVolumeRatio: this.annualVolumeRatio,
        },
      };
    }

    const swapFeeAPR = (feeRateBps / 10_000) * this.annualVolumeRatio;
    const totalAPY = swapFeeAPR + underlyingYieldAPY;

    return {
      pairAddress,
      swapFeeAPR,
      underlyingYieldAPY,
      totalAPY,
      breakdown: {
        feeRateBps,
        estimatedAnnualVolumeRatio: this.annualVolumeRatio,
      },
    };
  }

  private async fetchRedStonePrice(
    symbol: string,
  ): Promise<{ value: number; timestamp: number }> {
    const url = `${REDSTONE_BASE_URL}/?symbol=${encodeURIComponent(symbol)}&provider=redstone&limit=1`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new NetworkError(
        `Failed to fetch RedStone price for ${symbol}: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }

    if (!response.ok) {
      throw new NetworkError(
        `RedStone API returned ${response.status} for symbol ${symbol}`,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new NetworkError(
        `Failed to parse RedStone API response for symbol ${symbol}`,
      );
    }

    if (!Array.isArray(data) || data.length === 0) {
      throw new NetworkError(
        `No RedStone price data available for symbol ${symbol}`,
      );
    }

    const entry = data[0] as Record<string, unknown>;
    const value = entry["value"];
    const timestamp = entry["timestamp"];

    if (typeof value !== "number" || typeof timestamp !== "number") {
      throw new NetworkError(
        `Invalid RedStone price data format for symbol ${symbol}`,
      );
    }

    return { value, timestamp };
  }

  clearCache(address?: string): void {
    if (address) {
      this.cache.delete(address);
    } else {
      this.cache.clear();
    }
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  registerAsset(address: string, config: AssetConfig): void {
    this.assetMap[address] = config;
  }
}
