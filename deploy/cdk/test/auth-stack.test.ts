import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

describe('AuthStack (Gede-Test-Auth) — issue 033, ADR-0009', () => {
  function synth() {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { auth } = buildAppStacks(app, 'test');
    return Template.fromStack(auth);
  }

  it('creates exactly one Cognito User Pool with self-sign-up + email verification', () => {
    const template = synth();
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
    });
  });

  it('enforces a real password policy (not the Cognito zero-config default)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 8,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
        }),
      },
    });
  });

  it('creates exactly one public App Client — PKCE/SRP, no client secret', () => {
    const template = synth();
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']),
      // A public SPA client must never be configured for USER_PASSWORD_AUTH
      // (that flow sends the plaintext password over the wire — SRP only).
      PreventUserExistenceErrors: 'ENABLED',
    });
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const [client] = Object.values(clients) as Array<{ Properties: { ExplicitAuthFlows?: string[] } }>;
    expect(client.Properties.ExplicitAuthFlows ?? []).not.toContain('ALLOW_USER_PASSWORD_AUTH');
  });

  it('creates a groups/roles seam for later tenancy (issues 034/035)', () => {
    const template = synth();
    template.resourceCountIs('AWS::Cognito::UserPoolGroup', 1);
  });

  it('exports the User Pool id, client id, and a JWKS URI — the seam 032/034 validate JWTs against', () => {
    const template = synth();
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown; Description?: string }>;
    const values = Object.entries(outputs);
    expect(values.some(([key]) => key.includes('UserPoolId'))).toBe(true);
    expect(values.some(([key]) => key.includes('UserPoolClientId'))).toBe(true);
    const jwks = values.find(([key]) => key.includes('Jwks'));
    expect(jwks).toBeDefined();
  });

  it('is a regional managed resource — no VPC/subnet/security-group resources in this stack', () => {
    const template = synth();
    const json = template.toJSON();
    const types = Object.values(json.Resources as Record<string, { Type: string }>).map((r) => r.Type);
    expect(types.some((t) => t.startsWith('AWS::EC2::'))).toBe(false);
    expect(types.some((t) => t.startsWith('AWS::ECS::'))).toBe(false);
  });

  it('carries the four app-wide tags on the User Pool', () => {
    const template = synth();
    const expectedTags = Match.arrayWith([
      { Key: 'Application', Value: 'GeDe' },
      { Key: 'Environment', Value: 'test' },
      { Key: 'ManagedBy', Value: 'CDK' },
      { Key: 'Organization', Value: 'quadnomics' },
    ]);
    template.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTags: Match.objectLike({}) });
    // Cognito tags render as a map (UserPoolTags), not the {Key,Value}[] shape
    // most resources use — assert the map form directly.
    const pools = template.findResources('AWS::Cognito::UserPool');
    const [pool] = Object.values(pools) as Array<{ Properties: { UserPoolTags: Record<string, string> } }>;
    expect(pool.Properties.UserPoolTags).toMatchObject({
      Application: 'GeDe',
      Environment: 'test',
      ManagedBy: 'CDK',
      Organization: 'quadnomics',
    });
    void expectedTags;
  });

  it('matches the snapshot', () => {
    const template = synth();
    expect(template.toJSON()).toMatchSnapshot();
  });
});
