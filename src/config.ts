import { Network, Logger, Signer } from '@/types/common';
import { PollingStrategy } from '@/utils/polling';

/**
 * Contract addresses per network deployment.
 */
export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  factoryAddress: string;
  routerAddress: string;
  sorobanTimeout: number;
}

/**
 * SDK client configuration.
 */
export interface CoralSwapConfig {
  /** The Soroban network to connect to */
  network: Network;
  /** Optional custom RPC URL(s) to use. Can be a single string or an array of fallback URLs. */
  rpcUrl?: string | string[];
  /** Optional custom headers to include in all RPC requests (e.g. for authentication) */
  rpcHeaders?: Record<string, string>;
  /** Optional custom fetch options for the underlying RPC client */
  fetchOptions?: any;
  /** Optional secret key for signing transactions */
  secretKey?: string;
  /** Optional public key for the account */
  publicKey?: string;
  /** Optional logger for RPC request/response instrumentation. */
  logger?: Logger;
  /** External signer for wallet adapter pattern. Takes precedence over secretKey. */
  signer?: Signer;
  /** Default slippage tolerance in basis points (0-10000) */
  defaultSlippageBps?: number;
  /** Default transaction deadline in seconds from now */
  defaultDeadlineSec?: number;
  /** Maximum number of retry attempts for failed RPC calls */
  maxRetries?: number;
  /** Maximum delay between retry attempts */
  retryDelayMs?: number;
  /** Maximum delay in milliseconds between retry attempts */
  maxRetryDelayMs?: number;
  pollingStrategy?: PollingStrategy;
  pollingIntervalMs?: number;
  maxPollingAttempts?: number;
  pollingBackoffFactor?: number;
  maxPollingIntervalMs?: number;
}

/**
 * Known contract addresses for each network.
 */
export const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  [Network.TESTNET]: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    factoryAddress: "",
    routerAddress: "",
    sorobanTimeout: 30,
  },
  [Network.MAINNET]: {
    rpcUrl: "https://soroban.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    factoryAddress: "",
    routerAddress: "",
    sorobanTimeout: 30,
  },
  [Network.STAGING]: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    factoryAddress: "",
    routerAddress: "",
    sorobanTimeout: 30,
  },
};

/**
 * Load a network configuration with optional environment variable overrides.
 */
export function getNetworkConfig(network: Network, logger?: Logger): NetworkConfig {
  const baseConfig = NETWORK_CONFIGS[network];
  const factoryEnv = process.env.CORALSWAP_FACTORY_ADDRESS?.trim();
  const routerEnv = process.env.CORALSWAP_ROUTER_ADDRESS?.trim();

  if (factoryEnv && baseConfig.factoryAddress) {
    logger?.info(
      `CORALSWAP_FACTORY_ADDRESS override detected for network ${network}`,
      {
        network,
        configuredFactoryAddress: baseConfig.factoryAddress,
        envFactoryAddress: factoryEnv,
      },
    );
  }

  if (routerEnv && baseConfig.routerAddress) {
    logger?.info(
      `CORALSWAP_ROUTER_ADDRESS override detected for network ${network}`,
      {
        network,
        configuredRouterAddress: baseConfig.routerAddress,
        envRouterAddress: routerEnv,
      },
    );
  }

  return {
    ...baseConfig,
    factoryAddress: factoryEnv || baseConfig.factoryAddress,
    routerAddress: routerEnv || baseConfig.routerAddress,
  };
}

/**
 * Default SDK configuration values.
 */
export const DEFAULTS = {
  slippageBps: 50,
  deadlineSec: 1200,
  maxRetries: 3,
  retryDelayMs: 1000,
  maxRetryDelayMs: 30_000,
  pollingStrategy: PollingStrategy.LINEAR,
  pollingIntervalMs: 1000,
  maxPollingAttempts: 30,
  pollingBackoffFactor: 2,
  maxPollingIntervalMs: 10000,
  flashFeeFloorBps: 5,
  feeMinBps: 10,
  feeMaxBps: 100,
  baselineFeeBps: 30,
  timelockHours: 48,
  upgradeTimelockHours: 72,
  multiSigThreshold: 2,
  multiSigSigners: 3,
} as const;

/**
 * Standard default slippage tolerance expressed in basis points.
 *
 * This value is used when applications do not provide an explicit
 * `slippageBps` or `defaultSlippageBps` override.
 */
export const DEFAULT_SLIPPAGE = DEFAULTS.slippageBps;

/**
 * Precision constants for Soroban i128 math.
 */
export const PRECISION = {
  PRICE_SCALE: BigInt(1e14),
  BPS_DENOMINATOR: BigInt(10000),
  MIN_LIQUIDITY: BigInt(1000),
} as const;
