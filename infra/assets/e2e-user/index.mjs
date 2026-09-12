/**
 * Custom resource handler: the pipeline's live-suite account (`e2e@<domain>`) in the
 * Cognito user pool, with the permanent password held in Secrets Manager.
 *
 * Why not `AwsCustomResource`: its handler logs the whole CloudFormation event, so a
 * password passed as a property would land in CloudWatch. Here the resource carries only
 * the secret's ARN; the password is read at run time and never logged — this file logs
 * the request type and outcome, nothing else.
 *
 * Create / Update: `AdminCreateUser` (idempotent: `UsernameExistsException` is fine,
 * `MessageAction: SUPPRESS` so no invitation mail is sent, `email_verified: true` so the
 * ID token carries a verified address the sync service will bind) then
 * `AdminSetUserPassword` with `Permanent: true` (no FORCE_CHANGE_PASSWORD challenge).
 * Delete: `AdminDeleteUser` (a missing user is fine).
 *
 * Runs on the Lambda Node.js runtime, whose bundled AWS SDK v3 provides both clients.
 */
/* eslint-disable no-console -- a Lambda's stdout is its CloudWatch log; nothing secret is written */
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const cognito = new CognitoIdentityProviderClient({});
const secrets = new SecretsManagerClient({});

/** @param {{ RequestType: string, ResourceProperties: { UserPoolId: string, SecretArn: string, Username: string, DisplayName: string } }} event */
async function apply(event) {
  const { UserPoolId, SecretArn, Username, DisplayName } = event.ResourceProperties;
  if (event.RequestType === 'Delete') {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username }));
    } catch (error) {
      if (error?.name !== 'UserNotFoundException') throw error;
    }
    return;
  }
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: SecretArn }));
  const { password } = JSON.parse(secret.SecretString ?? '{}');
  if (typeof password !== 'string' || password === '') {
    throw new Error('the e2e user secret has no "password" field');
  }
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: Username },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: DisplayName },
        ],
      }),
    );
  } catch (error) {
    if (error?.name !== 'UsernameExistsException') throw error;
  }
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId, Username, Password: password, Permanent: true }),
  );
}

/** cfn-response: PUT the outcome to the pre-signed URL CloudFormation gave us. */
async function respond(event, context, status, reason) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason,
    PhysicalResourceId:
      event.PhysicalResourceId ??
      `${event.ResourceProperties.UserPoolId}/${event.ResourceProperties.Username}`,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: true,
    Data: {},
  });
  const response = await fetch(event.ResponseURL, {
    method: 'PUT',
    headers: { 'content-type': '', 'content-length': String(Buffer.byteLength(body)) },
    body,
  });
  if (!response.ok) throw new Error(`CloudFormation answered ${String(response.status)}`);
  console.log(`e2e user ${event.RequestType}: ${status} (${context.logStreamName})`);
}

export async function handler(event, context) {
  try {
    await apply(event);
    await respond(event, context, 'SUCCESS', '');
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`e2e user ${event.RequestType} failed: ${name}: ${message}`);
    await respond(event, context, 'FAILED', `${name}: ${message}. See ${context.logStreamName}.`);
  }
}
