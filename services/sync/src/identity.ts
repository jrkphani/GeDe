/**
 * The identity provider's half of account erasure (#111, ADR-037): once the
 * database holds a tombstone, the Cognito user is deleted so the identity
 * cannot sign in again. `AdminDeleteUser` needs the task role to hold
 * `cognito-idp:AdminDeleteUser` on the pool; `main.ts` wires this only when
 * `COGNITO_ERASE_IDENTITY` says the grant is in place. A user that is
 * already gone counts as deleted (a retried erasure must not fail on it).
 */
import {
  AdminDeleteUserCommand,
  UserNotFoundException,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

import type { IdentityStore } from './deps.js';

export function createCognitoIdentityStore(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): IdentityStore {
  return {
    async deleteUser(sub) {
      try {
        // In this pool `username` is the Cognito-generated UUID, which is the `sub`.
        await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: sub }));
      } catch (error) {
        if (error instanceof UserNotFoundException) return;
        throw error;
      }
    },
  };
}
