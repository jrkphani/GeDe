/**
 * FAKE — unsigned JWTs for end-to-end runs against an intercepted Cognito.
 * Amplify decodes the payload client-side and never verifies the signature
 * (the service does, which is why these never reach a real backend).
 */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'fake', typ: 'JWT' })}.${b64(payload)}.fakesignature`;
}

export interface FakeSession {
  region: string;
  userPoolId: string;
  clientId: string;
  sub: string;
  email: string;
  name: string;
}

export function fakeTokens(s: FakeSession): { AccessToken: string; IdToken: string } {
  const now = Math.floor(Date.now() / 1000);
  const iss = `https://cognito-idp.${s.region}.amazonaws.com/${s.userPoolId}`;
  return {
    AccessToken: fakeJwt({
      sub: s.sub,
      iss,
      client_id: s.clientId,
      origin_jti: 'fake',
      event_id: 'fake',
      token_use: 'access',
      scope: 'aws.cognito.signin.user.admin',
      auth_time: now,
      exp: now + 3600,
      iat: now,
      jti: 'fake',
      username: s.sub,
    }),
    IdToken: fakeJwt({
      sub: s.sub,
      iss,
      aud: s.clientId,
      token_use: 'id',
      'cognito:username': s.sub,
      email: s.email,
      email_verified: true,
      name: s.name,
      auth_time: now,
      exp: now + 3600,
      iat: now,
    }),
  };
}
