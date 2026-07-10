FROM node:24-bookworm-slim

ARG OPENCODE_VERSION
ENV TESTED_OPENCODE_VERSION=${OPENCODE_VERSION}

RUN npm install --global "opencode-ai@${OPENCODE_VERSION}"

WORKDIR /workspace
COPY scripts/opencode-compatibility/probe-server.mjs /opt/varro/probe-server.mjs

CMD ["node", "/opt/varro/probe-server.mjs"]
