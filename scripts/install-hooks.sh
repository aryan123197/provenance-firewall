#!/usr/bin/env bash
# Point git at the versioned hooks in .githooks/
git config core.hooksPath .githooks && echo "Git hooks installed (core.hooksPath=.githooks)"
