import { getNetworkConfig, NETWORK_CONFIGS } from '../src/config';
import { Network, Logger } from '../src/types/common';

const createMockLogger = (): jest.Mocked<Logger> => ({
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
});

describe('Config env overrides', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  it('uses base network config when no env vars are set', () => {
    delete process.env.CORALSWAP_FACTORY_ADDRESS;
    delete process.env.CORALSWAP_ROUTER_ADDRESS;

    expect(getNetworkConfig(Network.TESTNET)).toEqual(
      NETWORK_CONFIGS[Network.TESTNET],
    );
  });

  it('overrides factory address from CORALSWAP_FACTORY_ADDRESS', () => {
    process.env.CORALSWAP_FACTORY_ADDRESS = 'CENVFACTORYADDRESS';
    delete process.env.CORALSWAP_ROUTER_ADDRESS;

    const result = getNetworkConfig(Network.MAINNET);

    expect(result.factoryAddress).toBe('CENVFACTORYADDRESS');
    expect(result.routerAddress).toBe(NETWORK_CONFIGS[Network.MAINNET].routerAddress);
  });

  it('applies partial override and preserves routerAddress', () => {
    process.env.CORALSWAP_FACTORY_ADDRESS = 'CENVFACTORYONLY';
    delete process.env.CORALSWAP_ROUTER_ADDRESS;

    const result = getNetworkConfig(Network.STAGING);

    expect(result.factoryAddress).toBe('CENVFACTORYONLY');
    expect(result.routerAddress).toBe(NETWORK_CONFIGS[Network.STAGING].routerAddress);
  });

  it('logs a warning when env overrides replace configured addresses', () => {
    const originalFactory = NETWORK_CONFIGS[Network.TESTNET].factoryAddress;
    const originalRouter = NETWORK_CONFIGS[Network.TESTNET].routerAddress;

    try {
      NETWORK_CONFIGS[Network.TESTNET].factoryAddress = 'CGLOBALFACTORYADDRESS';
      NETWORK_CONFIGS[Network.TESTNET].routerAddress = 'CGLOBALROUTERADDRESS';

      process.env.CORALSWAP_FACTORY_ADDRESS = 'CENVFACTORYADDRESS';
      process.env.CORALSWAP_ROUTER_ADDRESS = 'CENVROUTERADDRESS';

      const logger = createMockLogger();
      getNetworkConfig(Network.TESTNET, logger);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('CORALSWAP_FACTORY_ADDRESS override detected'),
        expect.objectContaining({
          network: Network.TESTNET,
          configuredFactoryAddress: 'CGLOBALFACTORYADDRESS',
          envFactoryAddress: 'CENVFACTORYADDRESS',
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('CORALSWAP_ROUTER_ADDRESS override detected'),
        expect.objectContaining({
          network: Network.TESTNET,
          configuredRouterAddress: 'CGLOBALROUTERADDRESS',
          envRouterAddress: 'CENVROUTERADDRESS',
        }),
      );
    } finally {
      NETWORK_CONFIGS[Network.TESTNET].factoryAddress = originalFactory;
      NETWORK_CONFIGS[Network.TESTNET].routerAddress = originalRouter;
    }
  });
});
