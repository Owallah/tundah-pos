/**
 * etims/index.ts — provider factory.
 *
 * Swap implementations with ONE environment variable. The application core
 * never imports a concrete provider.
 *
 *   ETIMS_PROVIDER=null    -> disabled. Sales work, receipts are PROVISIONAL.
 *   ETIMS_PROVIDER=mock    -> deterministic fake signatures, for CI/dev.
 *   ETIMS_PROVIDER=oscu    -> live KRA. Requires certification first.
 */
import type { EtimsProvider } from './provider';
import { NullEtimsProvider } from './providers/null';
import { MockEtimsProvider } from './providers/mock';
import { OscuHttpProvider, type OscuConfig } from './providers/oscu-http';

export * from './types';
export * from './provider';
export { NullEtimsProvider, MockEtimsProvider, OscuHttpProvider };

export type EtimsProviderKind = 'null' | 'mock' | 'oscu';

export interface EtimsFactoryEnv {
  ETIMS_PROVIDER?: string;
  ETIMS_ENVIRONMENT?: string;
  ETIMS_TIN?: string;
  ETIMS_BHF_ID?: string;
  ETIMS_DVC_SRL_NO?: string;
  ETIMS_CMC_KEY?: string;
  ETIMS_AUTH_TRANSPORT?: string;
  ETIMS_TAXABLE_CONVENTION?: string;
  ETIMS_OPERATOR_ID?: string;
  ETIMS_OPERATOR_NAME?: string;
}

export function createEtimsProvider(
  env: EtimsFactoryEnv = process.env as EtimsFactoryEnv,
): EtimsProvider {
  const kind = (env.ETIMS_PROVIDER ?? 'null').toLowerCase() as EtimsProviderKind;

  switch (kind) {
    case 'mock':
      return new MockEtimsProvider();

    case 'oscu': {
      const missing = (['ETIMS_TIN', 'ETIMS_BHF_ID', 'ETIMS_DVC_SRL_NO'] as const)
        .filter((k) => !env[k]);
      if (missing.length) {
        throw new Error(
          `ETIMS_PROVIDER=oscu requires ${missing.join(', ')}. ` +
          `Use ETIMS_PROVIDER=null until KRA onboarding is complete.`,
        );
      }
      const config: OscuConfig = {
        environment: (env.ETIMS_ENVIRONMENT ?? 'SANDBOX') === 'PRODUCTION'
          ? 'PRODUCTION' : 'SANDBOX',
        credentials: {
          tin: env.ETIMS_TIN!,
          bhfId: env.ETIMS_BHF_ID!,
          dvcSrlNo: env.ETIMS_DVC_SRL_NO!,
          cmcKey: env.ETIMS_CMC_KEY,
        },
        // K5: default to sending both until KRA confirms which it expects.
        authTransport: (env.ETIMS_AUTH_TRANSPORT as OscuConfig['authTransport']) ?? 'both',
        // K3: default follows the spec's SALES sample.
        taxableAmountConvention:
          (env.ETIMS_TAXABLE_CONVENTION as 'gross' | 'net') ?? 'gross',
        operatorId: env.ETIMS_OPERATOR_ID ?? 'POS',
        operatorName: env.ETIMS_OPERATOR_NAME ?? 'POS',
      };
      return new OscuHttpProvider(config);
    }

    case 'null':
    default:
      return new NullEtimsProvider();
  }
}
