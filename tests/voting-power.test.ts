import {
  getVotingPower,
  getVotingPowerAtLedger,
  setVotingPowerQueryProvider,
} from '../src/utils/voting-power';

describe('voting power utilities', () => {
  afterEach(() => {
    setVotingPowerQueryProvider(undefined);
  });

  it('computes total power and percent share from own and delegated stake', async () => {
    setVotingPowerQueryProvider(async (address: string) => ({
      address,
      ownStake: 1200n,
      delegatedStake: 4800n,
      totalVotingPower: 20000n,
    }));

    const result = await getVotingPower('GABC123');

    expect(result.ownStake).toBe(1200n);
    expect(result.delegatedStake).toBe(4800n);
    expect(result.totalPower).toBe(6000n);
    expect(result.percentOfTotal).toBe(30);
  });

  it('uses the requested ledger for historical snapshots', async () => {
    const query = jest.fn(async (_address: string, ledger?: number) => ({
      address: 'GABC123',
      ownStake: 300n,
      delegatedStake: 700n,
      totalVotingPower: 10000n,
      ledger,
    }));

    setVotingPowerQueryProvider(query);

    const result = await getVotingPowerAtLedger('GABC123', 42);

    expect(query).toHaveBeenCalledWith('GABC123', 42);
    expect(result.totalPower).toBe(1000n);
    expect(result.percentOfTotal).toBe(10);
  });

  it('returns zero power for non-stakers', async () => {
    setVotingPowerQueryProvider(async () => null);

    const result = await getVotingPower('GNONSTAKER');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });
});
