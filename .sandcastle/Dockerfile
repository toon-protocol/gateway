# The AFK sandbox image: Node 22 (the version ci.yml's `test` job and
# package.json's engines.node pin), the gh CLI, Claude Code and the
# mattpocock-skills plugin. This is NOT the published gateway image: that is the
# repository-root Dockerfile, built by publish-gateway-image.yml, and nothing here
# touches it.
#
# NATIVE DEPS: the FULL `node:22-bookworm` image is built on
# `buildpack-deps:bookworm`, which bundles build-essential (gcc/g++/make) and
# python3, so `npm ci` succeeds here with NO extra apt packages. (If you ever
# switch this FROM to a `-slim` variant, you MUST add `build-essential python3`
# before the USER switch.)
FROM node:22-bookworm

# Links the published GHCR tag (ghcr.io/toon-protocol/gateway:sandcastle-agent, see
# the pull step in .github/workflows/agent-implement.yml) to this repo.
LABEL org.opencontainers.image.source="https://github.com/toon-protocol/gateway"

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Matt Pocock's skills, the same plugin used interactively. The runner starts each agent
# session with `/mattpocock-skills:implement` or `/mattpocock-skills:code-review`, so they
# must be installed here. A fresh install doesn't know the official marketplace yet, so add
# it first. This takes the plugin's latest release when the image is built; rebuild the
# image to pick up a newer one.
RUN /home/agent/.local/bin/claude plugin marketplace add anthropics/claude-plugins-official \
  && /home/agent/.local/bin/claude plugin install mattpocock-skills@claude-plugins-official

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
ENTRYPOINT ["sleep", "infinity"]
