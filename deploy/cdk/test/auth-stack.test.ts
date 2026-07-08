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

  it('the User Pool + App Client themselves stay regional-managed — no ECS/Fargate resources ever added here', () => {
    const template = synth();
    const json = template.toJSON();
    const types = Object.values(json.Resources as Record<string, { Type: string }>).map((r) => r.Type);
    // Issue 050 legitimately adds EC2 security groups (for the new VPC-attached
    // provisioning Lambda below) — but never an ECS/Fargate service; auth
    // itself is still never a compute tier the way api-stack.ts's `sync` stub
    // is.
    expect(types.some((t) => t.startsWith('AWS::ECS::'))).toBe(false);
    // Only security-group-shaped EC2 resources (the provisioning Lambda's own
    // SG + its one ingress rule into Data's SG) — never a VPC, subnet, or NAT
    // gateway of its own; those all belong to the Network stack.
    const ec2Types = types.filter((t) => t.startsWith('AWS::EC2::'));
    expect(ec2Types.every((t) => t === 'AWS::EC2::SecurityGroup' || t === 'AWS::EC2::SecurityGroupIngress')).toBe(
      true,
    );
  });

  // Issue 050 — the single riskiest change this issue can make: attaching a
  // PostConfirmation trigger must be an in-place `LambdaConfig` update, NEVER
  // a User Pool replacement (which would destroy every existing confirmed
  // user). CloudFormation only forces replacement of `AWS::Cognito::UserPool`
  // on a handful of specific properties — `UsernameAttributes`,
  // `AliasAttributes`, and (in some cases) `Schema`/`UsernameConfiguration` —
  // never on `LambdaConfig`. This asserts BOTH halves of that: (a) the new
  // trigger property exists, and (b) every property CloudFormation treats as
  // replacement-sensitive is byte-for-byte identical to what this stack
  // synthesized before issue 050 (see the checked-in pre-050 snapshot this
  // test's literals are copied from) — the strongest check available without
  // a live `cdk diff` against the actual deployed stack (this sandbox has no
  // credentials for the target AWS account; see the issue 050 report).
  it('attaches the PostConfirmation trigger as an in-place LambdaConfig update — Schema/UsernameAttributes unchanged from the pre-050 template (never a pool replacement)', () => {
    const template = synth();
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: Match.objectLike({
        PostConfirmation: Match.objectLike({}),
      }),
      // Byte-for-byte identical to the pre-050 template (this exact literal
      // shape is what's checked into __snapshots__/auth-stack.test.ts.snap
      // from before this issue) — no custom attribute was added.
      Schema: [{ Mutable: true, Name: 'email', Required: true }],
      // Also unchanged — the OTHER CloudFormation property (besides Schema)
      // that forces a UserPool replacement if it differs.
      UsernameAttributes: ['email'],
    });
  });

  it('provisions the PostConfirmation trigger as a VPC-attached Lambda with its own security group and DB-secret read access', () => {
    const template = synth();
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: Match.stringLikeRegexp('PostConfirmation trigger') },
    });
    const [fn] = Object.values(fns) as Array<{
      Properties: { VpcConfig?: { SecurityGroupIds: unknown[]; SubnetIds: unknown[] }; Handler: string };
    }>;
    expect(fn).toBeDefined();
    expect(fn?.Properties.Handler).toBe('index.handler');
    expect(fn?.Properties.VpcConfig?.SecurityGroupIds.length).toBeGreaterThan(0);
    expect(fn?.Properties.VpcConfig?.SubnetIds.length).toBeGreaterThan(0);

    // Exactly one new ingress rule into the (cross-stack) Data security
    // group — the provisioning Lambda's SG -> 5432, mirroring api-stack.ts /
    // migration-stack.ts's own forward-reference pattern.
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });

    // The DB secret read grant (secretsmanager:GetSecretValue) — a scoped IAM
    // policy statement, not a wildcard.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });

  it('grants Cognito permission to invoke the PostConfirmation trigger', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cognito-idp.amazonaws.com',
    });
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
