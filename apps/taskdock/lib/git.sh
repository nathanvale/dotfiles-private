#!/usr/bin/env bash
# TaskDock Git Library
# Git operations and provider detection

# Source common library
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Detect git provider (github or azure)
detect_git_provider() {
  local remote_url
  remote_url=$(git config --get remote.origin.url 2>/dev/null || echo "")

  if [[ "$remote_url" =~ github\.com ]]; then
    echo "github"
  elif [[ "$remote_url" =~ dev\.azure\.com ]] || [[ "$remote_url" =~ visualstudio\.com ]]; then
    echo "azure"
  else
    echo "unknown"
  fi
}

# Get current branch
get_current_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""
}

# Check if working tree is clean
is_working_tree_clean() {
  [[ -z "$(git status --porcelain 2>/dev/null)" ]]
}
