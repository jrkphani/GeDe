# PLACEHOLDER — used by infra only when services/sync/Dockerfile does not exist at synth
# time (a local `cdk synth` before that workspace is written). It is never meant to run:
# the pipeline always synthesizes with the real Dockerfile present.
FROM public.ecr.aws/docker/library/node:22-alpine
EXPOSE 3000
CMD ["node", "-e", "console.error('placeholder sync image; build services/sync'); process.exit(1)"]
