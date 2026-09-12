/**
 * Cognito pre-authentication trigger: the live suite's account and the `gede-e2e` app
 * client are bound to each other.
 *
 * The pool's sign-in policy must list PASSWORD (Cognito insists for a choice-based pool),
 * so the SPA client's USER_AUTH flow would accept the e2e user's password from any browser
 * if it ever leaked. This trigger makes that sign-in fail: `e2e@<domain>` may authenticate
 * only through the `gede-e2e` client (whose one flow needs IAM), and no other account may
 * use that client. Every other sign-in is untouched. The trigger fires for InitiateAuth and
 * AdminInitiateAuth alike; token refresh does not go through it.
 *
 * The client id is not passed in: pool → trigger → client → pool would be a CloudFormation
 * cycle, so the function finds the client by name in the pool it is invoked for (one
 * ListUserPoolClients per cold start).
 *
 * When that lookup fails (a throttle, a 5xx, an IAM hiccup) the failure is not cached — the
 * next invocation looks again — and only the e2e account is refused: everyone else signs in
 * as if the trigger were absent, because a non-e2e user on `gede-e2e` still needs IAM to
 * get anywhere and a refused SPA sign-in for every user would be an outage (#103).
 */
/* eslint-disable no-console -- a Lambda's stdout is its CloudWatch log; nothing secret is written */
import {
  CognitoIdentityProviderClient,
  ListUserPoolClientsCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});
const E2E_USERNAME = process.env.E2E_USERNAME;
const E2E_CLIENT_NAME = process.env.E2E_CLIENT_NAME;
/** @type {Map<string, Promise<string | undefined>>} pool id → the e2e client's id (settled lookups only) */
const e2eClientIds = new Map();

/**
 * The id of the client named E2E_CLIENT_NAME in `userPoolId`, or undefined when there is
 * none. A lookup that rejects is evicted before the rejection reaches the caller, so a
 * transient error is retried on the next invocation instead of poisoning the container.
 */
function e2eClientId(userPoolId) {
  let lookup = e2eClientIds.get(userPoolId);
  if (lookup === undefined) {
    lookup = (async () => {
      let NextToken;
      do {
        const page = await cognito.send(
          new ListUserPoolClientsCommand({ UserPoolId: userPoolId, MaxResults: 60, NextToken }),
        );
        const hit = (page.UserPoolClients ?? []).find((c) => c.ClientName === E2E_CLIENT_NAME);
        if (hit?.ClientId) return hit.ClientId;
        NextToken = page.NextToken;
      } while (NextToken);
      return undefined;
    })();
    e2eClientIds.set(userPoolId, lookup);
    lookup.catch(() => {
      e2eClientIds.delete(userPoolId);
    });
  }
  return lookup;
}

export async function handler(event) {
  const email = event.request?.userAttributes?.email;
  const isE2eUser = email === E2E_USERNAME || event.userName === E2E_USERNAME;
  let clientId;
  try {
    clientId = await e2eClientId(event.userPoolId);
  } catch (error) {
    // Fail closed for the one account the binding protects; open for everyone else.
    console.error('pre-auth client lookup failed', error);
    if (isE2eUser) {
      throw new Error('This account signs in only through the pipeline.');
    }
    return event;
  }
  const viaE2eClient = event.callerContext?.clientId === clientId;
  if (isE2eUser !== viaE2eClient) {
    console.warn(`pre-auth refused: e2eUser=${isE2eUser} e2eClient=${viaE2eClient}`);
    throw new Error(
      isE2eUser
        ? 'This account signs in only through the pipeline.'
        : 'This client is reserved for the pipeline.',
    );
  }
  return event;
}
