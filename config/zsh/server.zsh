# Server-only interactive shell configuration.
#
# Keep the shared .zshrc portable. Add settings here only when they are needed
# by commands run interactively on a headless server. Service processes launched
# by launchd must define their environment in their plist as well.

# Ollama tuning for a shared-memory local inference host.
export LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
export OLLAMA_HOST=0.0.0.0:11434
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
export OLLAMA_KEEP_ALIVE=30m
export OLLAMA_CONTEXT_LENGTH=8192
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_NUM_PARALLEL=4
export OLLAMA_NO_CLOUD=1

# LM Studio installs its supported CLI into a user-specific directory.
if [[ -d "$HOME/.lmstudio/bin" ]]; then
  path=("$HOME/.lmstudio/bin" $path)
  typeset -U path PATH
fi
