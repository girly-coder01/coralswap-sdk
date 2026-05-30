import { RWAModule, RWAPrice, RWASwapQuote, RWAPoolAPY } from '../src/modules/rwa';
import { RWAError, NetworkError } from '../src/errors';
import { CoralSwapClient } from '../src/client';

const DE_JTRSY = "deJTRSY";
const DE_JAAA = "deJAAA";
const UNKNOWN_ASSET = "CCXVW...UNKNOWN";
const USDC = "USDC";

const MOCK_NAV_JTRSY = 1.0023;
const MOCK_NAV_JAAA = 1_015.50;
const MOCK_TIMESTAMP = 1718000000000;
const MOCK_LATER_TIMESTAMP = 1718003600000;

let rwa: RWAModule;
let mockClient: CoralSwapClient;
let fetchSpy: jest.SpyInstance;

function createMockClient(): CoralSwapClient {
  return {
    pair: jest.fn().mockReturnValue({
      getFeeState: jest.fn().mockResolvedValue({
        priceLast: 100n,
        volAccumulator: 5000n,
        lastUpdated: 1718000000,
        feeCurrent: 30,
        feeMin: 10,
        feeMax: 100,
        emaAlpha: 50,
        feeLastChanged: 1718000000,
        emaDecayRate: 100,
        baselineFee: 30,
      }),
      getReserves: jest.fn().mockResolvedValue({
        reserve0: 10_000_000_000n,
        reserve1: 10_000_000_000n,
      }),
      getTokens: jest.fn().mockResolvedValue({
        token0: DE_JTRSY,
        token1: USDC,
      }),
    }),
  } as unknown as CoralSwapClient;
}

function mockFetchResponse(data: unknown, ok = true): void {
  fetchSpy.mockResolvedValue({
    ok,
    json: jest.fn().mockResolvedValue(data),
  });
}

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
  mockClient = createMockClient();
  rwa = new RWAModule(mockClient, {
    ttlMs: 0, // disable cache for predictable test results
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('RWAModule', () => {
  // -----------------------------------------------------------------------
  // getRWAPrice()
  // -----------------------------------------------------------------------
  describe('getRWAPrice()', () => {
    it('returns current NAV for a known Centrifuge asset (deJTRSY)', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const price = await rwa.getRWAPrice(DE_JTRSY);

      expect(price.nav).toBe(MOCK_NAV_JTRSY);
      expect(price.lastUpdated).toBe(MOCK_TIMESTAMP);
      expect(price.yieldAPY).toBeGreaterThan(0);
    });

    it('returns current NAV for deJAAA (CLO strategy)', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JAAA, timestamp: MOCK_TIMESTAMP },
      ]);

      const price = await rwa.getRWAPrice(DE_JAAA);

      expect(price.nav).toBe(MOCK_NAV_JAAA);
      expect(price.lastUpdated).toBe(MOCK_TIMESTAMP);
      expect(price.yieldAPY).toBeGreaterThan(0);
    });

    it('throws RWAError.UnsupportedAsset for an unknown address', async () => {
      await expect(rwa.getRWAPrice(UNKNOWN_ASSET)).rejects.toThrow(RWAError);
      await expect(rwa.getRWAPrice(UNKNOWN_ASSET)).rejects.toThrow(
        `Unsupported RWA asset: ${UNKNOWN_ASSET}`,
      );
    });

    it('throws RWAError with code RWA_UNSUPPORTED_ASSET for unknown address', async () => {
      try {
        await rwa.getRWAPrice(UNKNOWN_ASSET);
        fail('Expected error');
      } catch (err) {
        expect(err).toBeInstanceOf(RWAError);
        expect((err as RWAError).code).toBe('RWA_UNSUPPORTED_ASSET');
      }
    });

    it('throws NetworkError when RedStone API returns non-200', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        json: jest.fn(),
      });

      await expect(rwa.getRWAPrice(DE_JTRSY)).rejects.toThrow(NetworkError);
    });

    it('throws NetworkError when RedStone API returns empty array', async () => {
      mockFetchResponse([]);

      await expect(rwa.getRWAPrice(DE_JTRSY)).rejects.toThrow(NetworkError);
      await expect(rwa.getRWAPrice(DE_JTRSY)).rejects.toThrow(
        'No RedStone price data available for symbol deJTRSY',
      );
    });

    it('throws NetworkError when fetch itself fails', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNRESET'));

      await expect(rwa.getRWAPrice(DE_JTRSY)).rejects.toThrow(NetworkError);
    });

    it('returns cached price when TTL has not expired', async () => {
      rwa = new RWAModule(mockClient, { ttlMs: 60_000 });

      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const first = await rwa.getRWAPrice(DE_JTRSY);
      expect(first.nav).toBe(MOCK_NAV_JTRSY);

      mockFetchResponse([
        { value: 999.99, timestamp: MOCK_LATER_TIMESTAMP },
      ]);

      const second = await rwa.getRWAPrice(DE_JTRSY);
      expect(second.nav).toBe(MOCK_NAV_JTRSY);
    });

    it('returns fresh price when cache TTL has expired', async () => {
      rwa = new RWAModule(mockClient, { ttlMs: 0 });

      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      await rwa.getRWAPrice(DE_JTRSY);

      const newNav = 1.0100;
      mockFetchResponse([
        { value: newNav, timestamp: MOCK_LATER_TIMESTAMP },
      ]);

      const price = await rwa.getRWAPrice(DE_JTRSY);
      expect(price.nav).toBe(newNav);
    });
  });

  // -----------------------------------------------------------------------
  // quoteRWASwap()
  // -----------------------------------------------------------------------
  describe('quoteRWASwap()', () => {
    it('computes NAV-adjusted quote for deJTRSY -> USDC', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const amount = 1_000_000n;
      const quote = await rwa.quoteRWASwap(DE_JTRSY, USDC, amount);

      expect(quote.inputToken).toBe(DE_JTRSY);
      expect(quote.outputToken).toBe(USDC);
      expect(quote.inputAmount).toBe(amount);
      expect(quote.navInput).toBe(MOCK_NAV_JTRSY);
    });

    it('treats non-RWA output token (USDC) as NAV = 1.0', async () => {
      mockFetchResponse([
        { value: 2.0, timestamp: MOCK_TIMESTAMP },
      ]);

      const amount = 100n;
      const quote = await rwa.quoteRWASwap(DE_JTRSY, USDC, amount);

      expect(quote.navInput).toBe(2.0);
      expect(quote.navOutput).toBe(1.0);
      // 100 * (2.0 / 1.0) = 200
      expect(quote.outputAmount).toBe(200n);
    });

    it('handles both assets being RWA tokens', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue([
            { value: 100.0, timestamp: MOCK_TIMESTAMP },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue([
            { value: 50.0, timestamp: MOCK_TIMESTAMP },
          ]),
        });

      const amount = 100n;
      const quote = await rwa.quoteRWASwap(DE_JTRSY, DE_JAAA, amount);

      expect(quote.navInput).toBe(100.0);
      expect(quote.navOutput).toBe(50.0);
      // 100 * (100 / 50) = 200
      expect(quote.outputAmount).toBe(200n);
    });

    it('treats unknown fromToken as stablecoin (NAV = 1.0)', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const quote = await rwa.quoteRWASwap(UNKNOWN_ASSET, USDC, 100n);
      expect(quote.navInput).toBe(1.0);
      expect(quote.navOutput).toBe(1.0);
      expect(quote.outputAmount).toBe(100n);
    });

    it('treats unknown toToken as stablecoin (NAV = 1.0)', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const quote = await rwa.quoteRWASwap(DE_JTRSY, UNKNOWN_ASSET, 100n);
      expect(quote.navInput).toBe(MOCK_NAV_JTRSY);
      expect(quote.navOutput).toBe(1.0);
      // 100 * (1.0023 / 1.0) = 100 (due to BigInt rounding)
      expect(quote.outputAmount).toBe(100n);
    });
  });

  // -----------------------------------------------------------------------
  // getRWAPoolAPY()
  // -----------------------------------------------------------------------
  describe('getRWAPoolAPY()', () => {
    it('includes swap fee APR and underlying yield in total APY', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const apy = await rwa.getRWAPoolAPY('POOL_CONTRACT');

      expect(apy.breakdown.feeRateBps).toBe(30);
      expect(apy.swapFeeAPR).toBeGreaterThan(0);
      expect(apy.underlyingYieldAPY).toBeGreaterThan(0);
      expect(apy.totalAPY).toBeCloseTo(
        apy.swapFeeAPR + apy.underlyingYieldAPY,
        10,
      );
    });

    it('reads fee rate from the pair contract fee state', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const apy = await rwa.getRWAPoolAPY('POOL_CONTRACT');
      expect(apy.breakdown.feeRateBps).toBe(30);
    });

    it('computes correct swapFeeAPR from fee rate and annual volume ratio', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const apy = await rwa.getRWAPoolAPY('POOL_CONTRACT');
      const expectedSwapAPR = (30 / 10_000) * 365;
      expect(apy.swapFeeAPR).toBeCloseTo(expectedSwapAPR, 10);
    });

    it('returns RWAPoolAPY with all required fields', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      const apy = await rwa.getRWAPoolAPY('POOL_CONTRACT');

      expect(apy).toHaveProperty('pairAddress');
      expect(apy).toHaveProperty('swapFeeAPR');
      expect(apy).toHaveProperty('underlyingYieldAPY');
      expect(apy).toHaveProperty('totalAPY');
      expect(apy).toHaveProperty('breakdown.feeRateBps');
      expect(apy).toHaveProperty('breakdown.estimatedAnnualVolumeRatio');
    });
  });

  // -----------------------------------------------------------------------
  // Cache
  // -----------------------------------------------------------------------
  describe('cache management', () => {
    it('clearCache() removes entries for a specific asset', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      await rwa.getRWAPrice(DE_JTRSY);
      expect(rwa.getCacheSize()).toBe(1);

      rwa.clearCache(DE_JTRSY);
      expect(rwa.getCacheSize()).toBe(0);
    });

    it('clearCache() without args clears all entries', async () => {
      mockFetchResponse([
        { value: MOCK_NAV_JTRSY, timestamp: MOCK_TIMESTAMP },
      ]);

      await rwa.getRWAPrice(DE_JTRSY);
      await rwa.getRWAPrice(DE_JAAA);
      expect(rwa.getCacheSize()).toBe(2);

      rwa.clearCache();
      expect(rwa.getCacheSize()).toBe(0);
    });

    it('registerAsset() adds a new asset to the registry', async () => {
      const newAsset = 'C...NEW_ASSET';
      rwa.registerAsset(newAsset, {
        symbol: 'NEW_RWA',
        defaultYieldAPY: 5.0,
      });

      mockFetchResponse([
        { value: 123.45, timestamp: MOCK_TIMESTAMP },
      ]);

      const price = await rwa.getRWAPrice(newAsset);
      expect(price.nav).toBe(123.45);
      expect(price.yieldAPY).toBe(5.0);
    });
  });
});
