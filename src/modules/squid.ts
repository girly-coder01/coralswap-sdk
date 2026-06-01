import { CoralSwapClient } from "@/client";
import { DEFAULTS, PRECISION } from "@/config";
import { CrossChainError, ValidationError } from "@/errors";
import { resolveTokenIdentifier } from "@/utils/addresses";
import { validatePositiveAmount, validateSlippage } from "@/utils/validation";
import { TradeType } from "@/types/common";
import { SwapModule } from "./swap";
import {
  CrossChainQuote,
  CrossChainQuoteRequest,
  CrossChainStep,
  CrossChainSwapResult,
  SquidTransactionRequest,
} from "@/types/squid";
import type { SwapQuote, SwapRequest } from "@/types/swap";

type FetchLike = typeof fetch;

interface SquidRouteResponse {
  route?: {
    quoteId?: string;
    requestId?: string;
    transactionRequest?: SquidTransactionRequest;
    bridgeFee?: bigint | number | string;
    bridgeFeeBps?: number;
    estimatedTimeSeconds?: number;
    estimatedTime?: number;
    toAmount?: bigint | number | string;
    destinationAmount?: bigint | number | string;
    amountOut?: bigint | number | string;
    amountReceived?: bigint | number | string;
  };
  quoteId?: string;
  requestId?: string;
  transactionRequest?: SquidTransactionRequest;
  bridgeFee?: bigint | number | string;
  bridgeFeeBps?: number;
  estimatedTimeSeconds?: number;
  estimatedTime?: number;
  toAmount?: bigint | number | string;
  destinationAmount?: bigint | number | string;
  amountOut?: bigint | number | string;
  amountReceived?: bigint | number | string;
}

interface SquidStatusResponse {
  squidTransactionStatus?: string;
  status?: string;
  [key: string]: unknown;
}

interface SquidModuleOptions {
  apiBaseUrl?: string;
  integratorId?: string;
  fetchImpl?: FetchLike;
  defaultToChain?: string | number;
  statusPollIntervalMs?: number;
  statusPollAttempts?: number;
}

/**
 * Squid module -- cross-chain routing and execution through Squid Router.
 */
export class SquidModule {
  private client: CoralSwapClient;
  private apiBaseUrl: string;
  private integratorId?: string;
  private fetchImpl: FetchLike;
  private defaultToChain: string;
  private statusPollIntervalMs: number;
  private statusPollAttempts: number;
  private swapModule: SwapModule;

  constructor(client: CoralSwapClient, options: SquidModuleOptions = {}) {
    this.client = client;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://v2.api.squidrouter.com/v2";
    this.integratorId = options.integratorId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.defaultToChain = String(options.defaultToChain ?? client.network);
    this.statusPollIntervalMs = options.statusPollIntervalMs ?? 1000;
    this.statusPollAttempts = options.statusPollAttempts ?? 20;
    this.swapModule = new SwapModule(client);
  }

  /**
   * Get a cross-chain quote using Squid for the bridge leg and CoralSwap for the Stellar swap leg.
   */
  async getCrossChainQuote(request: CrossChainQuoteRequest): Promise<CrossChainQuote> {
    validatePositiveAmount(request.amount, "amount");

    const fromChain = this.normalizeChain(request.fromChain);
    const toChain = this.normalizeChain(request.toChain ?? this.defaultToChain);
    const totalSlippageBps = request.slippageBps ?? this.client.config.defaultSlippageBps ?? DEFAULTS.slippageBps;

    if (request.slippageBps !== undefined) {
      validateSlippage(request.slippageBps);
    }

    this.validateAsset(request.fromAsset, "fromAsset", fromChain);
    this.validateAsset(request.toAsset, "toAsset", toChain);

    if (this.isStellarChain(fromChain) && this.isStellarChain(toChain)) {
      return this.buildNativeQuote(request, fromChain, toChain, totalSlippageBps);
    }

    return this.buildBridgedQuote(request, fromChain, toChain, totalSlippageBps);
  }

  /**
   * Execute a cross-chain swap in the correct order.
   */
  async executeCrossChainSwap(
    quote: CrossChainQuote,
    signer: CrossChainBridgeSigner,
  ): Promise<CrossChainSwapResult> {
    const completedSteps: Array<"bridge" | "swap"> = [];

    try {
      const bridgeStep = quote.steps.find((step) => step.kind === "bridge");
      if (bridgeStep) {
        const transactionRequest = bridgeStep.transactionRequest;
        if (!transactionRequest) {
          throw new CrossChainError("Bridge step is missing a transaction request", {
            quoteId: quote.quoteId,
            requestId: quote.requestId,
          });
        }

        const bridgeTxHash = await this.submitBridgeTransaction(transactionRequest, signer);
        completedSteps.push("bridge");

        const swapStep = quote.steps.find((step) => step.kind === "swap");
        if (swapStep?.swapRequest) {
          const swapResult = await this.swapModule.execute(swapStep.swapRequest);
          completedSteps.push("swap");

          return {
            bridgeTxHash,
            swapTxHash: swapResult.txHash,
            completedSteps,
            quoteId: quote.quoteId,
            requestId: quote.requestId,
          };
        }

        throw new CrossChainError("Swap step is missing a CoralSwap request", {
          quoteId: quote.quoteId,
          requestId: quote.requestId,
        });
      }

      const swapStep = quote.steps.find((step) => step.kind === "swap");
      if (!swapStep?.swapRequest) {
        throw new CrossChainError("Cross-chain quote does not contain an executable swap step", {
          quoteId: quote.quoteId,
          requestId: quote.requestId,
        });
      }

      const swapResult = await this.swapModule.execute(swapStep.swapRequest);
      completedSteps.push("swap");

      return {
        swapTxHash: swapResult.txHash,
        completedSteps,
        quoteId: quote.quoteId,
        requestId: quote.requestId,
      };
    } catch (error) {
      if (error instanceof CrossChainError) {
        throw error;
      }

      throw new CrossChainError(
        error instanceof Error ? error.message : "Cross-chain swap failed",
        {
          quoteId: quote.quoteId,
          requestId: quote.requestId,
          error,
        },
      );
    }
  }

  private async buildNativeQuote(
    request: CrossChainQuoteRequest,
    fromChain: string,
    toChain: string,
    totalSlippageBps: number,
  ): Promise<CrossChainQuote> {
    const networkPassphrase = this.client.networkConfig.networkPassphrase;
    const fromAsset = resolveTokenIdentifier(request.fromAsset, networkPassphrase);
    const toAsset = resolveTokenIdentifier(request.toAsset, networkPassphrase);

    const swapQuote = await this.swapModule.getQuote({
      tokenIn: fromAsset,
      tokenOut: toAsset,
      amount: request.amount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: totalSlippageBps,
      to: request.toAddress ?? this.client.config.publicKey ?? undefined,
    });

    const swapRequest: SwapRequest = {
      tokenIn: fromAsset,
      tokenOut: toAsset,
      amount: request.amount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: totalSlippageBps,
      to: request.toAddress ?? this.client.config.publicKey ?? undefined,
      quote: swapQuote,
    };

    const steps: CrossChainStep[] = [
      {
        kind: "swap",
        chain: toChain,
        protocol: "CoralSwap",
        description: "Execute the Stellar-native swap directly on CoralSwap",
        swapRequest,
        swapQuote,
      },
    ];

    return {
      fromChain,
      toChain,
      fromAsset,
      toAsset,
      amount: request.amount,
      bridgeFee: 0n,
      swapFee: swapQuote.feeAmount,
      totalSlippageBps,
      estimatedTimeSeconds: 20,
      steps,
      bridgeAmountOut: request.amount,
      swapQuote,
      swapRequest,
    };
  }

  private async buildBridgedQuote(
    request: CrossChainQuoteRequest,
    fromChain: string,
    toChain: string,
    totalSlippageBps: number,
  ): Promise<CrossChainQuote> {
    const networkPassphrase = this.client.networkConfig.networkPassphrase;
    const toAddress = request.toAddress ?? this.client.config.publicKey ?? this.client.publicKey;

    const routeResponse = await this.postRoute({
      fromAddress: toAddress,
      fromChain,
      fromToken: request.fromAsset,
      fromAmount: request.amount.toString(),
      toChain,
      toToken: request.toAsset,
      toAddress,
      slippage: totalSlippageBps / 100,
    });

    const route = routeResponse.route ?? routeResponse;
    const quoteId = route.quoteId ?? routeResponse.quoteId;
    const requestId = route.requestId ?? routeResponse.requestId;
    const bridgeTransactionRequest = route.transactionRequest ?? routeResponse.transactionRequest;

    const bridgeFee = this.toBigInt(route.bridgeFee ?? routeResponse.bridgeFee ?? this.estimateBridgeFee(route, request.amount));
    const bridgeAmountOut = this.toBigInt(
      route.destinationAmount ?? route.toAmount ?? route.amountReceived ?? route.amountOut ?? routeResponse.destinationAmount ?? routeResponse.toAmount ?? routeResponse.amountReceived ?? routeResponse.amountOut ?? (request.amount - bridgeFee),
    );

    const resolvedToAsset = this.isStellarChain(toChain)
      ? resolveTokenIdentifier(request.toAsset, networkPassphrase)
      : request.toAsset;

    const resolvedFromAsset = this.isStellarChain(fromChain)
      ? resolveTokenIdentifier(request.fromAsset, networkPassphrase)
      : request.fromAsset;

    let swapQuote: SwapQuote;
    let swapRequest: SwapRequest;

    try {
      swapQuote = await this.swapModule.getQuote({
        tokenIn: resolvedFromAsset,
        tokenOut: resolvedToAsset,
        amount: bridgeAmountOut,
        tradeType: TradeType.EXACT_IN,
        slippageBps: totalSlippageBps,
        to: toAddress,
      });

      swapRequest = {
        tokenIn: swapQuote.tokenIn,
        tokenOut: swapQuote.tokenOut,
        amount: bridgeAmountOut,
        tradeType: TradeType.EXACT_IN,
        slippageBps: totalSlippageBps,
        to: toAddress,
        quote: swapQuote,
      };
    } catch {
      swapQuote = {
        tokenIn: resolvedFromAsset,
        tokenOut: resolvedToAsset,
        amountIn: bridgeAmountOut,
        amountOut: bridgeAmountOut,
        amountOutMin: bridgeAmountOut,
        priceImpactBps: 0,
        feeBps: 0,
        feeAmount: 0n,
        path: [resolvedFromAsset, resolvedToAsset],
        deadline: this.client.getDeadline(),
      };

      swapRequest = {
        tokenIn: resolvedFromAsset,
        tokenOut: resolvedToAsset,
        amount: bridgeAmountOut,
        tradeType: TradeType.EXACT_IN,
        slippageBps: totalSlippageBps,
        to: toAddress,
        quote: swapQuote,
      };
    }

    const estimatedTimeSeconds =
      route.estimatedTimeSeconds ?? route.estimatedTime ?? routeResponse.estimatedTimeSeconds ?? routeResponse.estimatedTime ?? 120;

    const steps: CrossChainStep[] = [];

    if (bridgeTransactionRequest) {
      steps.push({
        kind: "bridge",
        chain: fromChain,
        protocol: "Squid",
        description: "Bridge the source asset through Squid Router",
        transactionRequest: bridgeTransactionRequest,
      });
    }

    steps.push({
      kind: "swap",
      chain: toChain,
      protocol: "CoralSwap",
      description: "Swap the bridged asset into the CoralSwap destination pool",
      swapRequest,
      swapQuote,
    });

    return {
      fromChain,
      toChain,
      fromAsset: resolvedFromAsset,
      toAsset: resolvedToAsset,
      amount: request.amount,
      bridgeFee,
      swapFee: swapQuote.feeAmount,
      totalSlippageBps,
      estimatedTimeSeconds,
      steps,
      quoteId,
      requestId,
      bridgeAmountOut,
      swapQuote,
      swapRequest,
    };
  }

  private async submitBridgeTransaction(
    transactionRequest: SquidTransactionRequest,
    signer: CrossChainBridgeSigner,
  ): Promise<string> {
    const submitter = signer.sendTransaction ?? signer.submitTransaction;
    if (!submitter) {
      throw new CrossChainError("The provided signer cannot submit bridge transactions", {
        transactionRequest,
      });
    }

    try {
      const response = await submitter.call(signer, transactionRequest);
      return this.extractTxHash(response);
    } catch (error) {
      throw new CrossChainError(
        error instanceof Error ? error.message : "Bridge transaction failed",
        { transactionRequest, error },
      );
    }
  }

  private async waitForRouteCompletion(
    quote: CrossChainQuote,
    transactionId: string,
  ): Promise<SquidStatusResponse> {
    const fromChain = quote.fromChain;
    const toChain = quote.toChain;

    for (let attempt = 0; attempt < this.statusPollAttempts; attempt++) {
      const status = await this.getStatus({
        transactionId,
        requestId: quote.requestId,
        quoteId: quote.quoteId,
        fromChainId: fromChain,
        toChainId: toChain,
      });

      const routeStatus = String(status.squidTransactionStatus ?? status.status ?? "").toLowerCase();
      if (["success", "partial_success", "needs_gas"].includes(routeStatus)) {
        return status;
      }

      if (attempt < this.statusPollAttempts - 1) {
        await this.delay(this.statusPollIntervalMs);
      }
    }

    throw new CrossChainError("Squid route did not complete before the retry budget was exhausted", {
      quoteId: quote.quoteId,
      requestId: quote.requestId,
      transactionId,
    });
  }

  private async postRoute(payload: Record<string, unknown>): Promise<SquidRouteResponse> {
    return this.fetchJson<SquidRouteResponse>(`${this.apiBaseUrl}/route`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    });
  }

  private async getStatus(params: Record<string, unknown>): Promise<SquidStatusResponse> {
    const url = new URL(`${this.apiBaseUrl}/status`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return this.fetchJson<SquidStatusResponse>(url.toString(), {
      method: "GET",
      headers: this.buildHeaders(),
    });
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new CrossChainError(
        error instanceof Error ? error.message : "Squid API request failed",
        { url, error },
      );
    }

    if (!response.ok) {
      throw new CrossChainError(`Squid API request failed with status ${response.status}`, {
        url,
        status: response.status,
      });
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new CrossChainError("Unable to parse Squid API response", {
        url,
        error,
      });
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.integratorId) {
      headers["x-integrator-id"] = this.integratorId;
    }

    return headers;
  }

  private normalizeChain(chain: string | number | undefined): string {
    return String(chain ?? "").trim();
  }

  private isStellarChain(chain: string): boolean {
    const normalized = chain.toLowerCase();
    return (
      normalized === this.client.network.toLowerCase() ||
      normalized.includes("stellar") ||
      normalized === "testnet" ||
      normalized === "mainnet" ||
      normalized === "staging"
    );
  }

  private validateAsset(asset: string, name: string, chain: string): void {
    if (!asset || asset.trim().length === 0) {
      throw new ValidationError(`${name} must not be empty`);
    }

    if (this.isStellarChain(chain)) {
      const resolved = resolveTokenIdentifier(asset, this.client.networkConfig.networkPassphrase);
      if (!resolved || resolved.trim().length === 0) {
        throw new ValidationError(`${name} must resolve to a valid Stellar asset`, { asset });
      }
    }
  }

  private estimateBridgeFee(
    route: Partial<NonNullable<SquidRouteResponse["route"]>> | undefined,
    amount: bigint,
  ): bigint {
    const bridgeFeeBps = route?.bridgeFeeBps;
    if (typeof bridgeFeeBps === "number" && bridgeFeeBps >= 0) {
      return (amount * BigInt(bridgeFeeBps)) / PRECISION.BPS_DENOMINATOR;
    }

    return 0n;
  }

  private toBigInt(value: bigint | number | string | undefined): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim() !== "") return BigInt(value);
    return 0n;
  }

  private extractTxHash(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const candidate = value as { hash?: unknown; txHash?: unknown; transactionHash?: unknown };
      if (typeof candidate.hash === "string") return candidate.hash;
      if (typeof candidate.txHash === "string") return candidate.txHash;
      if (typeof candidate.transactionHash === "string") return candidate.transactionHash;
    }

    throw new CrossChainError("Bridge transaction did not return a transaction hash", {
      response: value,
    });
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export interface CrossChainBridgeSigner {
  sendTransaction?: (request: SquidTransactionRequest) => Promise<unknown>;
  submitTransaction?: (request: SquidTransactionRequest) => Promise<unknown>;
}