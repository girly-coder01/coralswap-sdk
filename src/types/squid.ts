import type { SwapQuote, SwapRequest } from "./swap";

/**
 * Request parameters for a Squid-powered cross-chain quote.
 */
export interface CrossChainQuoteRequest {
  /** Source chain identifier understood by Squid. */
  fromChain: string | number;
  /** Destination chain identifier. Defaults to the current Stellar network. */
  toChain?: string | number;
  /** Source asset identifier. */
  fromAsset: string;
  /** Destination asset identifier. */
  toAsset: string;
  /** Amount to route, in the source asset's smallest unit. */
  amount: bigint;
  /** Optional recipient address for the destination leg. */
  toAddress?: string;
  /** Optional slippage tolerance in basis points. */
  slippageBps?: number;
}

/**
 * A step inside a cross-chain execution plan.
 */
export interface CrossChainStep {
  /** Step kind. */
  kind: "bridge" | "swap";
  /** Chain on which this step executes. */
  chain: string;
  /** Integration used for the step. */
  protocol: "Squid" | "CoralSwap";
  /** Human-readable step description. */
  description: string;
  /** Optional Squid transaction request for bridge legs. */
  transactionRequest?: SquidTransactionRequest;
  /** Optional CoralSwap request for the destination swap leg. */
  swapRequest?: SwapRequest;
  /** Optional swap quote used to execute the destination leg. */
  swapQuote?: SwapQuote;
}

/**
 * Minimal shape of a Squid route transaction request.
 */
export interface SquidTransactionRequest {
  target: string;
  data: string;
  value?: string;
  gasLimit?: string;
  gasPrice?: string;
}

/**
 * Cross-chain quote returned by the Squid module.
 */
export interface CrossChainQuote {
  fromChain: string;
  toChain: string;
  fromAsset: string;
  toAsset: string;
  amount: bigint;
  bridgeFee: bigint;
  swapFee: bigint;
  totalSlippageBps: number;
  estimatedTimeSeconds: number;
  steps: CrossChainStep[];
  quoteId?: string;
  requestId?: string;
  bridgeAmountOut?: bigint;
  swapQuote?: SwapQuote;
  swapRequest?: SwapRequest;
}

/**
 * Result returned after executing a cross-chain swap.
 */
export interface CrossChainSwapResult {
  bridgeTxHash?: string;
  swapTxHash?: string;
  completedSteps: Array<"bridge" | "swap">;
  quoteId?: string;
  requestId?: string;
}