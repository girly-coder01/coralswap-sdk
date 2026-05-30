import { CoralSwapClient } from "@/client";
import { NetworkError } from "@/errors";

const REDSTONE_BASE_URL = "https://api.redstone.finance/prices";
const IMBALANCE_THRESHOLD_BPS = 1000;
const DEFAULT_MIN_LIQUIDITY_USD = 10_000;

export interface PoolHealth {
  isBalanced: boolean;
  liquidityDepthUSD: number;
  oracleDeviationBps: number | null;
  riskLevel: "low" | "medium" | "high";
}

export class AnalyticsModule {
  private client: CoralSwapClient;
  private tokenSymbolMap: Map<string, string> = new Map();
  private minLiquidityUsd: number;

  constructor(
    client: CoralSwapClient,
    opts?: { minLiquidityUsd?: number; tokenSymbolMap?: Record<string, string> },
  ) {
    this.client = client;
    this.minLiquidityUsd = opts?.minLiquidityUsd ?? DEFAULT_MIN_LIQUIDITY_USD;
    if (opts?.tokenSymbolMap) {
      for (const [address, symbol] of Object.entries(opts.tokenSymbolMap)) {
        this.tokenSymbolMap.set(address, symbol);
      }
    }
  }

  registerTokenSymbol(tokenAddress: string, symbol: string): void {
    this.tokenSymbolMap.set(tokenAddress, symbol);
  }

  async getPoolHealth(pairAddress: string): Promise<PoolHealth> {
    const pair = this.client.pair(pairAddress);
    const [reserves, tokens] = await Promise.all([
      pair.getReserves(),
      pair.getTokens(),
    ]);

    const price0 = await this.tryFetchPrice(tokens.token0);
    const price1 = await this.tryFetchPrice(tokens.token1);

    const hasBothPrices = price0 !== null && price1 !== null;

    let oracleDeviationBps: number | null = null;
    let isBalanced = true;

    if (hasBothPrices) {
      const reserveRatio =
        Number(reserves.reserve0) / Number(reserves.reserve1);
      const oracleRatio = price0! / price1!;

      if (oracleRatio > 0) {
        const deviation = Math.abs(reserveRatio - oracleRatio) / oracleRatio;
        oracleDeviationBps = Math.round(deviation * 10_000);

        if (oracleDeviationBps > IMBALANCE_THRESHOLD_BPS) {
          isBalanced = false;
        }
      }
    }

    let liquidityDepthUSD = 0;
    if (hasBothPrices) {
      liquidityDepthUSD =
        Number(reserves.reserve0) * price0! +
        Number(reserves.reserve1) * price1!;
    } else if (price0 !== null) {
      liquidityDepthUSD = Number(reserves.reserve0) * price0!;
    } else if (price1 !== null) {
      liquidityDepthUSD = Number(reserves.reserve1) * price1!;
    }

    let riskLevel: "low" | "medium" | "high";
    if (!isBalanced) {
      riskLevel = "high";
    } else if (liquidityDepthUSD < this.minLiquidityUsd) {
      riskLevel = "medium";
    } else {
      riskLevel = "low";
    }

    return {
      isBalanced,
      liquidityDepthUSD,
      oracleDeviationBps,
      riskLevel,
    };
  }

  clearCache(): void {
    this.tokenSymbolMap.clear();
  }

  private async tryFetchPrice(tokenAddress: string): Promise<number | null> {
    const symbol = this.tokenSymbolMap.get(tokenAddress);
    if (!symbol) {
      return null;
    }

    try {
      return await this.fetchRedStonePrice(symbol);
    } catch {
      return null;
    }
  }

  private async fetchRedStonePrice(symbol: string): Promise<number> {
    const url = `${REDSTONE_BASE_URL}/?symbol=${encodeURIComponent(symbol)}&provider=redstone&limit=1`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new NetworkError(
        `Failed to fetch RedStone price for ${symbol}`,
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

    if (typeof value !== "number") {
      throw new NetworkError(
        `Invalid RedStone price data format for symbol ${symbol}`,
      );
    }

    return value;
  }
}
