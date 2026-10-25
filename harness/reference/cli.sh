#!/usr/bin/env bash
# Reference CLI for validating harness/cli, see cli.ts
exec bun "$(dirname "$0")/cli.ts" "$@"
