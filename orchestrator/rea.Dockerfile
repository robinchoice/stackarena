# Workspace for the decompilation analysis: REA with Ghidra, LIEF, binutils and 7-Zip from the
# rea-sandbox skill (~/dev/rea/rea-tooling), plus wabt, Prettier and Claude Code. Built by
# decompile.ts as stackarena-rea:1 with orchestrator/ as context.
FROM rea-ghidra:12.1.4-rea6.5.0
ARG CLAUDE_CODE_VERSION=2.1.288
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 wabt jq \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} prettier@3.6.2 \
    && mkdir -p /home/agent/.claude/projects /home/agent/.claude/skills && chown -R 1000:1000 /home/agent

COPY init.sh /usr/local/bin/stackarena-init
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/stackarena-init"]
