# Workspace for one contest run. Every team gets the same image, so toolchains are fixed here.
FROM ubuntu:24.04
ARG CLAUDE_CODE_VERSION=2.1.288
ARG PLAYWRIGHT_VERSION=1.63.0
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git iptables iproute2 jq pkg-config unzip xz-utils \
      postgresql-client libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
      libxdo-dev xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22 for Claude Code and npm-based stacks, Bun for the harness and the Bun teams
RUN curl -fsSL https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

# The agent runs as uid 1000 like the host user, so files in /work keep their owner
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash agent
USER agent
ENV CARGO_HOME=/home/agent/.cargo RUSTUP_HOME=/home/agent/.rustup PATH=/home/agent/.cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && git config --global init.defaultBranch main
USER root

COPY init.sh /usr/local/bin/stackarena-init
ENTRYPOINT ["/usr/local/bin/stackarena-init"]
