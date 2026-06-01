import { CoralSwapClient } from "../src/client";
import { SquidModule } from "../src/modules/squid";
import { CrossChainError } from "../src/errors";
import { Network } from "../src/types/common";
import { SwapModule } from "../src/modules/swap";

describe("SquidModule", () => {
  const TEST_SECRET = "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";
  const FROM_ASSET = "0x1111111111111111111111111111111111111111";
  const TO_ASSET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  let client: CoralSwapClient;
  let module: SquidModule;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    module = new SquidModule(client, {
      apiBaseUrl: "https://v2.api.squidrouter.com/v2",
      integratorId: "test-integrator",
      fetchImpl: globalThis.fetch.bind(globalThis),
      statusPollAttempts: 2,
      statusPollIntervalMs: 0,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns a bridged quote with fee breakdown and steps", async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          route: {
            quoteId: "quote-123",
            requestId: "request-123",
            transactionRequest: {
              target: "0xbridge",
              data: "0xabc",
              value: "0",
              gasLimit: "1000000",
            },
            bridgeFeeBps: 25,
            estimatedTimeSeconds: 180,
            destinationAmount: "975",
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          squidTransactionStatus: "success",
        }),
      } as any);

    const stubSwapQuote = {
      tokenIn: TO_ASSET,
      tokenOut: TO_ASSET,
      amountIn: 975n,
      amountOut: 950n,
      amountOutMin: 940n,
      priceImpactBps: 12,
      feeBps: 30,
      feeAmount: 5n,
      path: [TO_ASSET, TO_ASSET],
      deadline: 1234567890,
    };

    const getQuoteSpy = jest
      .spyOn(SwapModule.prototype, "getQuote")
      .mockResolvedValue(stubSwapQuote as any);

    module = new SquidModule(client, {
      apiBaseUrl: "https://v2.api.squidrouter.com/v2",
      integratorId: "test-integrator",
      fetchImpl: fetchMock as any,
      statusPollAttempts: 2,
      statusPollIntervalMs: 0,
    });

    const quote = await module.getCrossChainQuote({
      fromChain: "ethereum",
      toChain: Network.TESTNET,
      fromAsset: FROM_ASSET,
      toAsset: TO_ASSET,
      amount: 1000n,
      slippageBps: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getQuoteSpy).toHaveBeenCalledTimes(1);
    expect(quote.bridgeFee).toBe(2n);
    expect(quote.swapFee).toBe(5n);
    expect(quote.totalSlippageBps).toBe(50);
    expect(quote.estimatedTimeSeconds).toBe(180);
    expect(quote.steps).toHaveLength(2);
    expect(quote.steps[0].kind).toBe("bridge");
    expect(quote.steps[1].kind).toBe("swap");
  });

  it("bypasses the bridge leg for Stellar-native swaps", async () => {
    const fetchMock = jest.fn();
    const stubSwapQuote = {
      tokenIn: TO_ASSET,
      tokenOut: TO_ASSET,
      amountIn: 1000n,
      amountOut: 990n,
      amountOutMin: 980n,
      priceImpactBps: 8,
      feeBps: 30,
      feeAmount: 3n,
      path: [TO_ASSET, TO_ASSET],
      deadline: 1234567890,
    };

    const getQuoteSpy = jest
      .spyOn(SwapModule.prototype, "getQuote")
      .mockResolvedValue(stubSwapQuote as any);

    module = new SquidModule(client, {
      apiBaseUrl: "https://v2.api.squidrouter.com/v2",
      fetchImpl: fetchMock as any,
    });

    const quote = await module.getCrossChainQuote({
      fromChain: Network.TESTNET,
      toChain: Network.TESTNET,
      fromAsset: TO_ASSET,
      toAsset: TO_ASSET,
      amount: 1000n,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getQuoteSpy).toHaveBeenCalledTimes(1);
    expect(quote.bridgeFee).toBe(0n);
    expect(quote.steps).toHaveLength(1);
    expect(quote.steps[0].kind).toBe("swap");
  });

  it("executes the bridge before the destination swap", async () => {
    const executionOrder: string[] = [];

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        route: {
          quoteId: "quote-123",
          requestId: "request-123",
          transactionRequest: {
            target: "0xbridge",
            data: "0xabc",
            value: "0",
          },
          bridgeFeeBps: 25,
          estimatedTimeSeconds: 180,
          destinationAmount: "975",
        },
      }),
    } as any);

    const swapExecuteSpy = jest
      .spyOn(SwapModule.prototype, "execute")
      .mockImplementation(async () => {
        executionOrder.push("swap");
        return {
          txHash: "SWAP_TX",
          amountIn: 975n,
          amountOut: 950n,
          feePaid: 5n,
          ledger: 100,
          timestamp: 1234567890,
        } as any;
      });

    module = new SquidModule(client, {
      apiBaseUrl: "https://v2.api.squidrouter.com/v2",
      fetchImpl: fetchMock as any,
      statusPollAttempts: 1,
      statusPollIntervalMs: 0,
    });

    const quote = await module.getCrossChainQuote({
      fromChain: "ethereum",
      toChain: Network.TESTNET,
      fromAsset: FROM_ASSET,
      toAsset: TO_ASSET,
      amount: 1000n,
    });

    const signer = {
      sendTransaction: jest.fn().mockImplementation(async () => {
        executionOrder.push("bridge");
        return { hash: "BRIDGE_TX" };
      }),
    };

    const result = await module.executeCrossChainSwap(quote, signer);

    expect(executionOrder).toEqual(["bridge", "swap"]);
    expect(result.bridgeTxHash).toBe("BRIDGE_TX");
    expect(result.swapTxHash).toBe("SWAP_TX");
    expect(signer.sendTransaction).toHaveBeenCalledTimes(1);
    expect(swapExecuteSpy).toHaveBeenCalledTimes(1);
  });

  it("throws CrossChainError when the bridge fails", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        route: {
          quoteId: "quote-123",
          requestId: "request-123",
          transactionRequest: {
            target: "0xbridge",
            data: "0xabc",
          },
          bridgeFeeBps: 25,
          estimatedTimeSeconds: 180,
          destinationAmount: "975",
        },
      }),
    } as any);

    jest.spyOn(SwapModule.prototype, "getQuote").mockResolvedValue({
      tokenIn: TO_ASSET,
      tokenOut: TO_ASSET,
      amountIn: 975n,
      amountOut: 950n,
      amountOutMin: 940n,
      priceImpactBps: 12,
      feeBps: 30,
      feeAmount: 5n,
      path: [TO_ASSET, TO_ASSET],
      deadline: 1234567890,
    } as any);

    module = new SquidModule(client, {
      apiBaseUrl: "https://v2.api.squidrouter.com/v2",
      fetchImpl: fetchMock as any,
    });

    const quote = await module.getCrossChainQuote({
      fromChain: "ethereum",
      toChain: Network.TESTNET,
      fromAsset: FROM_ASSET,
      toAsset: TO_ASSET,
      amount: 1000n,
    });

    const signer = {
      sendTransaction: jest.fn().mockRejectedValue(new Error("bridge failed")),
    };

    await expect(module.executeCrossChainSwap(quote, signer)).rejects.toBeInstanceOf(CrossChainError);
  });
});