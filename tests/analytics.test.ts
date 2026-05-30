import { AnalyticsModule, PoolHealth } from '../src/modules/analytics';
import { CoralSwapClient } from '../src/client';

const TOKEN_A = 'C...TOKEN_A';
const TOKEN_B = 'C...TOKEN_B';
const PAIR = 'C...PAIR';

function createMockClient(opts: {
  reserve0?: bigint;
  reserve1?: bigint;
  token0?: string;
  token1?: string;
} = {}): CoralSwapClient {
  return {
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue({
        reserve0: opts.reserve0 ?? 1_000_000n,
        reserve1: opts.reserve1 ?? 1_000_000n,
      }),
      getTokens: jest.fn().mockResolvedValue({
        token0: opts.token0 ?? TOKEN_A,
        token1: opts.token1 ?? TOKEN_B,
      }),
    }),
  } as unknown as CoralSwapClient;
}

let analytics: AnalyticsModule;
let mockClient: CoralSwapClient;
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
  mockClient = createMockClient();
  analytics = new AnalyticsModule(mockClient, { minLiquidityUsd: 10_000 });
  analytics.registerTokenSymbol(TOKEN_A, 'TOKEN_A_SYM');
  analytics.registerTokenSymbol(TOKEN_B, 'TOKEN_B_SYM');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function mockFetchResponse(data: unknown, ok = true): void {
  fetchSpy.mockResolvedValue({
    ok,
    json: jest.fn().mockResolvedValue(data),
  });
}

describe('AnalyticsModule', () => {
  describe('getPoolHealth()', () => {
    it('healthy balanced pool returns riskLevel low', async () => {
      mockFetchResponse([{ value: 1.0 }]);
      mockFetchResponse([{ value: 1.0 }]);

      const health = await analytics.getPoolHealth(PAIR);

      expect(health.isBalanced).toBe(true);
      expect(health.liquidityDepthUSD).toBe(2_000_000);
      expect(health.oracleDeviationBps).toBe(0);
      expect(health.riskLevel).toBe('low');
    });

    it('imbalanced pool (>10% off oracle) returns isBalanced false and riskLevel high', async () => {
      mockFetchResponse([{ value: 1.0 }]);
      mockFetchResponse([{ value: 1.0 }]);

      const client = createMockClient({
        reserve0: 1_200_000n,
        reserve1: 1_000_000n,
      });
      analytics = new AnalyticsModule(client, { minLiquidityUsd: 10_000 });
      analytics.registerTokenSymbol(TOKEN_A, 'TOKEN_A_SYM');
      analytics.registerTokenSymbol(TOKEN_B, 'TOKEN_B_SYM');

      const health = await analytics.getPoolHealth(PAIR);

      expect(health.isBalanced).toBe(false);
      expect(health.oracleDeviationBps).toBe(2000);
      expect(health.riskLevel).toBe('high');
    });

    it('low liquidity pool (< k TVL) returns riskLevel medium even when balanced', async () => {
      mockFetchResponse([{ value: 1.0 }]);
      mockFetchResponse([{ value: 1.0 }]);

      const client = createMockClient({
        reserve0: 100n,
        reserve1: 100n,
      });
      analytics = new AnalyticsModule(client, { minLiquidityUsd: 10_000 });
      analytics.registerTokenSymbol(TOKEN_A, 'TOKEN_A_SYM');
      analytics.registerTokenSymbol(TOKEN_B, 'TOKEN_B_SYM');

      const health = await analytics.getPoolHealth(PAIR);

      expect(health.isBalanced).toBe(true);
      expect(health.liquidityDepthUSD).toBe(200);
      expect(health.riskLevel).toBe('medium');
    });

    it('no RedStone feed for one token returns oracleDeviationBps null without error', async () => {
      mockFetchResponse([{ value: 1.0 }]);

      analytics = new AnalyticsModule(mockClient, { minLiquidityUsd: 10_000 });
      analytics.registerTokenSymbol(TOKEN_A, 'TOKEN_A_SYM');

      const health = await analytics.getPoolHealth(PAIR);

      expect(health.oracleDeviationBps).toBeNull();
      expect(health.isBalanced).toBe(true);
      expect(health.liquidityDepthUSD).toBe(1_000_000);
      expect(health.riskLevel).toBe('low');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('all feeds fail returns oracleDeviationBps null', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));

      const health = await analytics.getPoolHealth(PAIR);

      expect(health.oracleDeviationBps).toBeNull();
      expect(health.isBalanced).toBe(true);
      expect(health.liquidityDepthUSD).toBe(0);
    });
  });
});
