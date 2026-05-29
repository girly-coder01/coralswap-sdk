import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { LiquidityModule } from '../../src/modules/liquidity';
import { SwapModule } from '../../src/modules/swap';
import { TradeType } from '../../src/types/swap';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: create pair → add liquidity → swap → remove liquidity.
 *
 * Prerequisites (set via env vars):
 *   TEST_KEYPAIR          – funded testnet secret key (S...)
 *   TEST_TOKEN_A          – contract address of token A
 *   TEST_TOKEN_B          – contract address of token B
 *   TEST_RPC_URL          – optional RPC override
 *
 * The suite is idempotent: it uses whatever pair already exists for the token
 * pair (or creates one), so repeated runs do not conflict.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// Wrap every test in a conditional so the suite is skipped cleanly when
// STELLAR_TESTNET is not set, without needing jest.config changes.
const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('CoralSwap lifecycle (testnet)', () => {
  let client: CoralSwapClient;
  let liquidity: LiquidityModule;
  let swap: SwapModule;
  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;

  // Amounts chosen to be small enough to avoid draining a test account.
  const AMOUNT_A = toSorobanAmount('1', 7);   // 1 token
  const AMOUNT_B = toSorobanAmount('1', 7);   // 1 token
  const SLIPPAGE_BPS = 200;                   // 2% – generous for testnet

  beforeAll(async () => {
    const secretKey = requireEnv('TEST_KEYPAIR');
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');

    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey,
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });

    liquidity = new LiquidityModule(client);
    swap = new SwapModule(client);
  });

  // -----------------------------------------------------------------------
  // Helper: fetch token balance for the test account
  // -----------------------------------------------------------------------
  async function tokenBalance(tokenAddress: string): Promise<bigint> {
    const { SorobanRpc, xdr, Address, nativeToScVal, scValToNative } = await import('@stellar/stellar-sdk');
    // Use the SEP-41 balance(address) view call via the pair's RPC server
    const server = client.server;
    const account = await server.getAccount(client.publicKey);

    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const op = xdr.Operation.fromXDR(
      new (await import('@stellar/stellar-sdk')).Contract(tokenAddress)
        .call('balance', nativeToScVal(Address.fromString(client.publicKey), { type: 'address' }))
        .toXDR(),
      'base64',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: client.networkConfig.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`balance simulation failed for ${tokenAddress}`);
    }
    const retval = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) return 0n;
    return BigInt(scValToNative(retval) as string | number | bigint);
  }

  // -----------------------------------------------------------------------
  // 1. Ensure pair exists (create if needed)
  // -----------------------------------------------------------------------
  it('resolves or creates the token pair', async () => {
    let addr = await client.getPairAddress(tokenA, tokenB);

    if (!addr) {
      const op = client.factory.buildCreatePair(tokenA, tokenB);
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      addr = await client.getPairAddress(tokenA, tokenB);
    }

    expect(addr).toBeTruthy();
    pairAddress = addr!;
  });

  // -----------------------------------------------------------------------
  // 2. Add liquidity — assert LP token balance increases
  // -----------------------------------------------------------------------
  it('adds liquidity and receives LP tokens', async () => {
    const lpTokenAddress = await client.pair(pairAddress).getLPTokenAddress();
    const lpBefore = await client.lpToken(lpTokenAddress).balance(client.publicKey);

    const quote = await liquidity.getAddLiquidityQuote(tokenA, tokenB, AMOUNT_A);

    const result = await liquidity.addLiquidity({
      tokenA,
      tokenB,
      amountADesired: quote.amountA,
      amountBDesired: quote.amountB,
      amountAMin: (quote.amountA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (quote.amountB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });

    expect(result.txHash).toBeTruthy();

    const lpAfter = await client.lpToken(lpTokenAddress).balance(client.publicKey);
    expect(lpAfter).toBeGreaterThan(lpBefore);
  });

  // -----------------------------------------------------------------------
  // 3. Swap tokenA → tokenB — assert tokenB balance increases
  // -----------------------------------------------------------------------
  it('swaps tokenA for tokenB and receives tokenB', async () => {
    const swapAmount = toSorobanAmount('0.1', 7);
    const balBefore = await tokenBalance(tokenB);

    const quote = await swap.getQuote({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });

    expect(quote.amountOut).toBeGreaterThan(0n);

    const result = await swap.execute({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
      deadline: client.getDeadline(60),
    });

    expect(result.hash).toBeTruthy();

    const balAfter = await tokenBalance(tokenB);
    expect(balAfter).toBeGreaterThan(balBefore);
  });

  // -----------------------------------------------------------------------
  // 4. Remove liquidity — assert LP tokens decrease, underlying tokens return
  // -----------------------------------------------------------------------
  it('removes liquidity and returns underlying tokens', async () => {
    const lpTokenAddress = await client.pair(pairAddress).getLPTokenAddress();
    const lpBalance = await client.lpToken(lpTokenAddress).balance(client.publicKey);

    // Remove half of what we hold
    const toRemove = lpBalance / 2n;
    if (toRemove === 0n) {
      // Nothing to remove — skip gracefully (shouldn't happen after step 2)
      return;
    }

    const balABefore = await tokenBalance(tokenA);
    const balBBefore = await tokenBalance(tokenB);

    const quote = await liquidity.getRemoveLiquidityQuote(tokenA, tokenB, toRemove);

    const result = await liquidity.removeLiquidity({
      tokenA,
      tokenB,
      liquidity: toRemove,
      amountAMin: (quote.amountA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (quote.amountB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });

    expect(result.txHash).toBeTruthy();

    const lpAfter = await client.lpToken(lpTokenAddress).balance(client.publicKey);
    expect(lpAfter).toBeLessThan(lpBalance);

    const balAAfter = await tokenBalance(tokenA);
    const balBAfter = await tokenBalance(tokenB);
    // At least one of the two underlying balances must have increased
    expect(balAAfter + balBAfter).toBeGreaterThan(balABefore + balBBefore);
  });
});
