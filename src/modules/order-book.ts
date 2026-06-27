
import { Trade, TradeFilter } from '../types/trade';

export async function getLimitOrders(_address: string): Promise<Trade[]> {
  // This is a mock implementation.
  // In a real implementation, this would fetch filled limit orders from a data source.
  return [
    {
      type: 'limit-fill',
      tokenIn: 'USDC',
      tokenOut: 'ETH',
      amountIn: 1000000000n,
      amountOut: 500000000000000000n,
      price: 2000,
      timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
      txHash: '0x' + '1'.repeat(64),
    },
  ];
}

export async function getDcaExecutions(_address: string): Promise<Trade[]> {
  // This is a mock implementation.
  // In a real implementation, this would fetch DCA executions from a data source.
  return [
    {
      type: 'dca-execution',
      tokenIn: 'USDC',
      tokenOut: 'BTC',
      amountIn: 500000000n,
      amountOut: 10000000n,
      price: 50000,
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      txHash: '0x' + '2'.repeat(64),
    },
  ];
}

export async function getTradeHistory(address: string, filter?: TradeFilter): Promise<Trade[]> {
  // Mock implementations for all trade types
  const limitOrders = await getLimitOrders(address);
  const dcaExecutions = await getDcaExecutions(address);
  
  const swaps: Trade[] = [
    {
      type: 'swap',
      tokenIn: 'ETH',
      tokenOut: 'USDC',
      amountIn: 1000000000000000000n,
      amountOut: 2000000000n,
      price: 2000,
      timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
      txHash: '0x' + '3'.repeat(64),
    }
  ];

  const stopLosses: Trade[] = [
    {
      type: 'stop-loss-trigger',
      tokenIn: 'BTC',
      tokenOut: 'USDC',
      amountIn: 100000000n,
      amountOut: 45000000000n,
      price: 45000,
      timestamp: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000), // 4 days ago
      txHash: '0x' + '4'.repeat(64),
    }
  ];

  let allTrades = [...limitOrders, ...dcaExecutions, ...swaps, ...stopLosses];

  if (filter) {
    if (filter.types && filter.types.length > 0) {
      allTrades = allTrades.filter(t => filter.types!.includes(t.type));
    }
    if (filter.fromDate) {
      allTrades = allTrades.filter(t => t.timestamp >= filter.fromDate!);
    }
    if (filter.toDate) {
      allTrades = allTrades.filter(t => t.timestamp <= filter.toDate!);
    }
  }

  // Sort chronological (descending - newest first)
  allTrades.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (filter?.limit !== undefined) {
    allTrades = allTrades.slice(0, filter.limit);
  }

  return allTrades;
}
