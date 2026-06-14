# Testing AI Agent Spawning

## Quick Test

### Reload Tmux Config

From inside any tmux session:

```text
Ctrl-g r
```

Expected result:

```text
Config reloaded!
```

### Test Agent Prefix Bindings

Use the agent prefix table:

| Keys | Action |
|------|--------|
| `Ctrl-g A c` | Spawn Claude |
| `Ctrl-g A g` | Spawn Gemini |
| `Ctrl-g A x` | Spawn Codex |
| `Ctrl-g A o` | Spawn OpenAI legacy |
| `Ctrl-g A n` | New AI window with Claude |
| `Ctrl-g A v` | Spawn Claude vertical |
| `Ctrl-g A i` | Show agent context |
| `Ctrl-g A s` | Show agent status |
| `Ctrl-g A p` | Open agent scratchpad |
| `Ctrl-g A b` | Show agent brief |
| `Ctrl-g A r` | Review current diff |

How to press:

1. Press `Ctrl-g`.
2. Release both keys.
3. Press uppercase `A`.
4. Press the final command key.

Example:

```text
Ctrl-g A g
```

Spawns Gemini in the current tmux window.

## Manual Test

From inside a tmux pane:

```bash
~/.config/tmuxinator/scripts/spawn-ai-agent.sh claude
~/.config/tmuxinator/scripts/spawn-ai-agent.sh gemini current horizontal
~/.config/tmuxinator/scripts/spawn-ai-agent.sh codex current horizontal
```

## Verify Bindings

From tmux command mode:

```text
Ctrl-g :
list-keys -T ai-agents
```

Expected result includes:

```text
bind-key -T ai-agents c run-shell "...spawn-ai-agent.sh claude..."
bind-key -T ai-agents g run-shell "...spawn-ai-agent.sh gemini..."
bind-key -T ai-agents x run-shell "...spawn-ai-agent.sh codex..."
bind-key -T ai-agents i display-popup "...agent-context..."
bind-key -T ai-agents s display-popup "...agent-status..."
bind-key -T ai-agents p display-popup "...agent-scratchpad..."
bind-key -T ai-agents b display-popup "...agent-brief..."
bind-key -T ai-agents r display-popup "...review-my-diff..."
```

## Common Issues

### Config Reload Message Does Not Appear

Start or attach to tmux first:

```bash
tmuxinator start dotfiles
```

### Binding Does Nothing

- Release `Ctrl-g` before pressing `A`.
- Check the table with `list-keys -T ai-agents`.
- Run the manual script test.

### Script Says Not In Tmux

Start a tmux session:

```bash
tmuxinator start <project>
```

### Permission Denied

Make scripts executable:

```bash
chmod +x ~/.config/tmuxinator/scripts/spawn-ai-agent.sh
chmod +x ~/code/dotfiles/bin/tmux/agent-status
chmod +x ~/code/dotfiles/bin/tmux/agent-scratchpad
chmod +x ~/code/dotfiles/bin/agent-context
chmod +x ~/code/dotfiles/bin/agent-brief
chmod +x ~/code/dotfiles/bin/review-my-diff
```

## Success Indicators

- New agent pane appears.
- Repository path matches the current pane.
- Layout retiled automatically.
- Missing tools show install guidance instead of failing silently.

## Related Files

- `~/.config/tmux/tmux.conf`
- `~/.config/tmuxinator/scripts/spawn-ai-agent.sh`
- `~/code/dotfiles/bin/tmux/agent-status`
- `~/code/dotfiles/bin/tmux/agent-scratchpad`
- `~/code/dotfiles/bin/agent-context`
