import { getExodeAuthConfig, getExodeEmbedConfig } from './config';

const ORIGINAL_ENV = process.env;

describe('Exode auth config', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      EXODE_MAIN_URL: 'https://api.exode.biz',
      EXODE_MAIN_SERVICE_ID: 'LibreChatBridge',
      EXODE_MAIN_SERVICE_SECRET: 'service-secret',
      EXODE_MAIN_ISSUER: 'exode-backend-main',
      EXODE_EMBED_JWT_TTL_MS: '300000',
      EXODE_MCP_SERVER_NAME: 'exode',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns private and public configuration', () => {
    expect(getExodeAuthConfig()).toEqual({
      mainUrl: 'https://api.exode.biz/',
      serviceId: 'LibreChatBridge',
      serviceSecret: 'service-secret',
      issuer: 'exode-backend-main',
      embedJwtTtlMs: 300000,
      mcpServerName: 'exode',
    });
    expect(getExodeEmbedConfig()).toEqual({
      enabled: true,
      protocol: 1,
    });
  });

  it('is disabled until all private settings are configured', () => {
    delete process.env.EXODE_MAIN_SERVICE_SECRET;
    expect(getExodeEmbedConfig().enabled).toBe(false);
  });

  /**
   * No origin list gates the embed — school domains are main's to know — so the only settings
   * left to validate are the ones this service cannot work without.
   */
  it('rejects an invalid token lifetime', () => {
    process.env.EXODE_EMBED_JWT_TTL_MS = '30000';
    expect(() => getExodeAuthConfig()).toThrow('between 60000 and 900000');
  });

  it('requires the main service credentials', () => {
    delete process.env.EXODE_MAIN_ISSUER;
    expect(() => getExodeAuthConfig()).toThrow('EXODE_MAIN_ISSUER is required');
  });
});
