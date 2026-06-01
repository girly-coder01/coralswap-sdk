import { FeeModule } from '../src/modules/fees';
import { CoralSwapClient } from '../src/client';
import { FeeState } from '../src/types/pool';
import { xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default FeeState fixture. Override individual fields as needed. */
function makeFeeState(overrides: Partial<FeeState> = {}): FeeState {
    return {
        priceLast: 0n,
        volAccumulator: 500n,
        lastUpdated: Math.floor(Date.now() / 1000) - 60, // 1 min ago (fresh)
        feeCurrent: 30,
        feeMin: 10,
        feeMax: 100,
        emaAlpha: 50,
        feeLastChanged: Math.floor(Date.now() / 1000) - 120,
        emaDecayRate: 5,
        baselineFee: 30,
        ...overrides,
    };
}

/**
 * Build a mock CoralSwapClient for FeeModule tests.
 *
 * `feeBps` controls the value returned by `getDynamicFee()`.
 * `feeState` controls the value returned by `getFeeState()`.
 */
function createMockClient(opts: {
    feeBps?: number;
    feeState?: FeeState;
    /** Per-pair overrides keyed by address */
    pairs?: Record<string, { feeBps?: number; feeState?: FeeState }>;
} = {}): CoralSwapClient {
    const defaultFeeBps = opts.feeBps ?? 30;
    const defaultFeeState = opts.feeState ?? makeFeeState();

    return {
        pair: jest.fn().mockImplementation((addr: string) => {
            const override = opts.pairs?.[addr];
            return {
                getDynamicFee: jest.fn().mockResolvedValue(override?.feeBps ?? defaultFeeBps),
                getFeeState: jest.fn().mockResolvedValue(override?.feeState ?? defaultFeeState),
            };
        }),
        router: {
            getDynamicFee: jest.fn().mockResolvedValue(defaultFeeBps),
        },
        factory: {
            getFeeParameters: jest.fn().mockResolvedValue({
                feeMin: 10,
                feeMax: 100,
                emaAlpha: 50,
                flashFeeBps: 5,
            }),
        },
    } as unknown as CoralSwapClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeModule', () => {
    const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

    // -----------------------------------------------------------------------
    // estimateSwapFee()
    // -----------------------------------------------------------------------
    describe('estimateSwapFee()', () => {
        it('calculates correct fee amount: (amountIn * feeBps) / 10000', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            const { feeBps, feeAmount } = await module.estimateSwapFee(PAIR, 10_000n);

            expect(feeBps).toBe(30);
            // 10000 * 30 / 10000 = 30
            expect(feeAmount).toBe(30n);
        });

        it('returns zero fee for zero amount', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            await expect(module.estimateSwapFee(PAIR, 0n)).rejects.toThrow(
                'amountIn must be greater than 0',
            );
        });

        it('handles large amounts without overflow', async () => {
            const client = createMockClient({ feeBps: 100 });
            const module = new FeeModule(client);

            const largeAmount = 10n ** 24n; // 1 septillion stroops
            const { feeAmount } = await module.estimateSwapFee(PAIR, largeAmount);

            // (10^24 * 100) / 10000 = 10^22
            expect(feeAmount).toBe(10n ** 22n);
        });

        it('returns feeBps matching the dynamic fee from the pair', async () => {
            const client = createMockClient({ feeBps: 75 });
            const module = new FeeModule(client);

            const { feeBps } = await module.estimateSwapFee(PAIR, 1000n);

            expect(feeBps).toBe(75);
        });

        it('calculates correctly at max fee (100 bps = 1%)', async () => {
            const client = createMockClient({ feeBps: 100 });
            const module = new FeeModule(client);

            const { feeAmount } = await module.estimateSwapFee(PAIR, 1_000_000n);

            // 1000000 * 100 / 10000 = 10000
            expect(feeAmount).toBe(10_000n);
        });

        it('calculates correctly at min fee (10 bps = 0.1%)', async () => {
            const client = createMockClient({ feeBps: 10 });
            const module = new FeeModule(client);

            const { feeAmount } = await module.estimateSwapFee(PAIR, 1_000_000n);

            // 1000000 * 10 / 10000 = 1000
            expect(feeAmount).toBe(1_000n);
        });

        it('floors fractional fees (integer division)', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            // 100 * 30 / 10000 = 0.3 → floors to 0
            const { feeAmount } = await module.estimateSwapFee(PAIR, 100n);

            expect(feeAmount).toBe(0n);
        });
    });

    // -----------------------------------------------------------------------
    // isStale()
    // -----------------------------------------------------------------------
    describe('isStale()', () => {
        it('returns false when lastUpdated is recent (within default 1 hour)', async () => {
            const recentState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 60, // 1 min ago
            });
            const client = createMockClient({ feeState: recentState });
            const module = new FeeModule(client);

            const stale = await module.isStale(PAIR);

            expect(stale).toBe(false);
        });

        it('returns true when lastUpdated is older than default 1 hour', async () => {
            const oldState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
            });
            const client = createMockClient({ feeState: oldState });
            const module = new FeeModule(client);

            const stale = await module.isStale(PAIR);

            expect(stale).toBe(true);
        });

        it('respects custom maxAgeSec parameter', async () => {
            const state = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 600, // 10 min ago
            });
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            // 300 sec threshold → 10 min > 5 min → stale
            expect(await module.isStale(PAIR, 300)).toBe(true);
            // 900 sec threshold → 10 min < 15 min → not stale
            expect(await module.isStale(PAIR, 900)).toBe(false);
        });

        it('returns true when lastUpdated is exactly at boundary + 1', async () => {
            const now = Math.floor(Date.now() / 1000);
            const state = makeFeeState({ lastUpdated: now - 3601 }); // 1 second past 1 hour
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            expect(await module.isStale(PAIR)).toBe(true);
        });

        it('returns false when lastUpdated is exactly at boundary', async () => {
            const now = Math.floor(Date.now() / 1000);
            const state = makeFeeState({ lastUpdated: now - 3600 }); // exactly 1 hour
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            // now - lastUpdated = 3600, not > 3600, so not stale
            expect(await module.isStale(PAIR)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // getCurrentFee()
    // -----------------------------------------------------------------------
    describe('getCurrentFee()', () => {
        it('returns correct FeeEstimate shape with all fields', async () => {
            const feeState = makeFeeState({
                feeCurrent: 45,
                baselineFee: 30,
                feeMin: 10,
                feeMax: 100,
                volAccumulator: 1234n,
                emaDecayRate: 7,
                lastUpdated: Math.floor(Date.now() / 1000) - 120,
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.pairAddress).toBe(PAIR);
            expect(estimate.currentFeeBps).toBe(45);
            expect(estimate.baselineFeeBps).toBe(30);
            expect(estimate.feeMin).toBe(10);
            expect(estimate.feeMax).toBe(100);
            expect(estimate.volatility).toBe(1234n);
            expect(estimate.emaDecayRate).toBe(7);
            expect(estimate.lastUpdated).toBe(feeState.lastUpdated);
        });

        it('sets isStale to false when fee was recently updated', async () => {
            const feeState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 30, // 30 sec ago
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.isStale).toBe(false);
        });

        it('sets isStale to true when fee is older than 1 hour', async () => {
            const feeState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.isStale).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // compareFees()
    // -----------------------------------------------------------------------
    describe('compareFees()', () => {
        it('returns fee estimates for multiple pairs', async () => {
            const pairs = ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5'];
            const client = createMockClient({
                pairs: {
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4': { feeState: makeFeeState({ feeCurrent: 20 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM': { feeState: makeFeeState({ feeCurrent: 50 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5': { feeState: makeFeeState({ feeCurrent: 80 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees(pairs);

            expect(results).toHaveLength(3);
        });

        it('preserves input order in results', async () => {
            const pairs = ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M'];
            const client = createMockClient({
                pairs: {
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM': { feeState: makeFeeState({ feeCurrent: 10 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4': { feeState: makeFeeState({ feeCurrent: 50 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M': { feeState: makeFeeState({ feeCurrent: 90 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees(pairs);

            expect(results[0].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
            expect(results[0].currentFeeBps).toBe(10);
            expect(results[1].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4');
            expect(results[1].currentFeeBps).toBe(50);
            expect(results[2].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M');
            expect(results[2].currentFeeBps).toBe(90);
        });

        it('returns empty array for empty input', async () => {
            const client = createMockClient();
            const module = new FeeModule(client);

            const results = await module.compareFees([]);

            expect(results).toHaveLength(0);
        });

        it('each result has correct isStale flag', async () => {
            const now = Math.floor(Date.now() / 1000);
            const FRESH_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4';
            const STALE_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM';
            const client = createMockClient({
                pairs: {
                    [FRESH_ADDR]: { feeState: makeFeeState({ lastUpdated: now - 60 }) },
                    [STALE_ADDR]: { feeState: makeFeeState({ lastUpdated: now - 7200 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees([FRESH_ADDR, STALE_ADDR]);

            expect(results[0].isStale).toBe(false);
            expect(results[1].isStale).toBe(true);
        });
    });
});

// ---------------------------------------------------------------------------
// Helpers for getFeeHistory / analyzeTrend
// ---------------------------------------------------------------------------

/** Build a minimal mock event as returned by server.getEvents(). */
function makeFeeEvent(ledger: number, newFeeBps: number, volatility = 0n): object {
    // Build a minimal ScVal map with new_fee_bps and volatility
    const map = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('new_fee_bps'),
            val: xdr.ScVal.scvU32(newFeeBps),
        }),
        new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('volatility'),
            val: xdr.ScVal.scvI128(
                new xdr.Int128Parts({
                    lo: xdr.Uint64.fromString((volatility & 0xFFFFFFFFFFFFFFFFn).toString()),
                    hi: xdr.Int64.fromString((volatility >> 64n).toString()),
                }),
            ),
        }),
    ]);

    return {
        ledger,
        ledgerClosedAt: new Date(ledger * 1000).toISOString(),
        value: map,
    };
}

/** Create a mock client that also mocks server.getEvents(). */
function createMockClientWithEvents(
    events: object[],
    opts: Parameters<typeof createMockClient>[0] = {},
): CoralSwapClient {
    const base = createMockClient(opts);
    (base as any).server = {
        getEvents: jest.fn().mockResolvedValue({ events }),
    };
    return base;
}

// ---------------------------------------------------------------------------
// getFeeHistory() tests
// ---------------------------------------------------------------------------

describe('FeeModule – getFeeHistory()', () => {
    const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

    it('returns empty history when no events exist', async () => {
        const client = createMockClientWithEvents([]);
        const module = new FeeModule(client);

        const history = await module.getFeeHistory(PAIR);

        expect(history.pairAddress).toBe(PAIR);
        expect(history.entries).toHaveLength(0);
        expect(history.minFeeBps).toBe(0);
        expect(history.maxFeeBps).toBe(0);
        expect(history.avgFeeBps).toBe(0);
    });

    it('parses a single fee-update event correctly', async () => {
        const client = createMockClientWithEvents([makeFeeEvent(1000, 30, 500n)]);
        const module = new FeeModule(client);

        const history = await module.getFeeHistory(PAIR);

        expect(history.entries).toHaveLength(1);
        expect(history.entries[0].ledger).toBe(1000);
        expect(history.entries[0].feeBps).toBe(30);
        expect(history.entries[0].volatility).toBe(500n);
        expect(history.minFeeBps).toBe(30);
        expect(history.maxFeeBps).toBe(30);
        expect(history.avgFeeBps).toBe(30);
    });

    it('computes correct min, max, avg across multiple events', async () => {
        const events = [
            makeFeeEvent(1000, 20),
            makeFeeEvent(1001, 50),
            makeFeeEvent(1002, 80),
        ];
        const client = createMockClientWithEvents(events);
        const module = new FeeModule(client);

        const history = await module.getFeeHistory(PAIR);

        expect(history.minFeeBps).toBe(20);
        expect(history.maxFeeBps).toBe(80);
        expect(history.avgFeeBps).toBe(50); // (20+50+80)/3 = 50
    });

    it('sorts entries oldest-first regardless of event order', async () => {
        const events = [
            makeFeeEvent(1002, 80),
            makeFeeEvent(1000, 20),
            makeFeeEvent(1001, 50),
        ];
        const client = createMockClientWithEvents(events);
        const module = new FeeModule(client);

        const history = await module.getFeeHistory(PAIR);

        expect(history.entries[0].ledger).toBe(1000);
        expect(history.entries[1].ledger).toBe(1001);
        expect(history.entries[2].ledger).toBe(1002);
    });

    it('passes startLedger to server.getEvents()', async () => {
        const client = createMockClientWithEvents([]);
        const module = new FeeModule(client);

        await module.getFeeHistory(PAIR, 5000);

        expect((client as any).server.getEvents).toHaveBeenCalledWith(
            expect.objectContaining({ startLedger: 5000 }),
        );
    });

    it('rejects invalid pair address', async () => {
        const client = createMockClientWithEvents([]);
        const module = new FeeModule(client);

        await expect(module.getFeeHistory('not-an-address')).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// analyzeTrend() tests
// ---------------------------------------------------------------------------

describe('FeeModule – analyzeTrend()', () => {
    const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

    it('returns stable trend with current fee when no history exists', async () => {
        const feeState = makeFeeState({ feeCurrent: 30 });
        const client = createMockClientWithEvents([], { feeState });
        const module = new FeeModule(client);

        const trend = await module.analyzeTrend(PAIR);

        expect(trend.direction).toBe('stable');
        expect(trend.startFeeBps).toBe(30);
        expect(trend.endFeeBps).toBe(30);
        expect(trend.changeBps).toBe(0);
        expect(trend.dataPoints).toBe(0);
    });

    it('detects increasing trend', async () => {
        const events = [makeFeeEvent(1000, 20), makeFeeEvent(1001, 50)];
        const client = createMockClientWithEvents(events);
        const module = new FeeModule(client);

        const trend = await module.analyzeTrend(PAIR);

        expect(trend.direction).toBe('increasing');
        expect(trend.startFeeBps).toBe(20);
        expect(trend.endFeeBps).toBe(50);
        expect(trend.changeBps).toBe(30);
        expect(trend.dataPoints).toBe(2);
    });

    it('detects decreasing trend', async () => {
        const events = [makeFeeEvent(1000, 80), makeFeeEvent(1001, 30)];
        const client = createMockClientWithEvents(events);
        const module = new FeeModule(client);

        const trend = await module.analyzeTrend(PAIR);

        expect(trend.direction).toBe('decreasing');
        expect(trend.changeBps).toBe(-50);
    });

    it('detects stable trend when start equals end', async () => {
        const events = [makeFeeEvent(1000, 30), makeFeeEvent(1001, 50), makeFeeEvent(1002, 30)];
        const client = createMockClientWithEvents(events);
        const module = new FeeModule(client);

        const trend = await module.analyzeTrend(PAIR);

        expect(trend.direction).toBe('stable');
        expect(trend.changeBps).toBe(0);
        expect(trend.dataPoints).toBe(3);
    });

    it('includes pairAddress in result', async () => {
        const client = createMockClientWithEvents([makeFeeEvent(1000, 30)]);
        const module = new FeeModule(client);

        const trend = await module.analyzeTrend(PAIR);

        expect(trend.pairAddress).toBe(PAIR);
    });
});
