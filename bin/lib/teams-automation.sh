#!/usr/bin/env bash
# Shared helpers for driving the Microsoft Teams desktop app via Peekaboo.
#
# Hard-won constraints these helpers encode (2026-08-04):
#   1. Teams MUST be frontmost before ANY synthetic input. Input goes to whatever
#      app has focus, so an unfocused Teams means your message is typed into the
#      terminal you launched from. This is the single most important gate here.
#   2. `peekaboo paste` works against Teams web content; `peekaboo type` is
#      unreliable. Always route text through the clipboard.
#   3. Teams' accessibility tree is opaque (~15 nested groups, no compose box, no
#      message list). Element-targeted clicks are impossible; search-result clicks
#      need `--foreground --input-strategy synthOnly`.
#   4. The window title is the ONLY trustworthy read-back of which conversation is
#      open. It is the safety gate before any text is inserted.

TEAMS_APP="Microsoft Teams"

# --- identity -------------------------------------------------------------

teams_frontmost() {
  timeout 20s peekaboo list apps --json 2>/dev/null \
    | jq -r '.data.applications[] | select(.isActive==true) | .name'
}

teams_window_title() {
  timeout 20s peekaboo inspect-ui --app "$TEAMS_APP" 2>/dev/null \
    | grep -m1 '^Window:' | sed 's/^Window: //'
}

# Bring Teams to the front and refuse to continue unless it actually got there.
teams_require_focus() {
  timeout 20s peekaboo app switch --to "$TEAMS_APP" >/dev/null 2>&1
  sleep "${TEAMS_FOCUS_SETTLE:-2}"
  local f
  f=$(teams_frontmost)
  if [ "$f" != "$TEAMS_APP" ]; then
    echo "ABORT: Teams is not frontmost (frontmost = '${f:-unknown}')." >&2
    echo "       Refusing to send synthetic input; it would go to the wrong app." >&2
    return 1
  fi
  return 0
}

# Assert the open conversation matches what we intend.
#
# The cache name and the window title do NOT always agree. For a 1:1 DM the cache
# says "Current User, Alex Example" but Teams titles the window "Alex Example",
# dropping the self name. So: try the whole name first, then require that EVERY
# participant other than self appears in the title. That still fails closed if we
# landed in a different chat, because a different chat has different names.
teams_require_conversation() {
  local expect="$1" t self part ok
  t=$(teams_window_title)
  self="${TEAMS_SELF_NAME:-Current User}"

  case "$t" in *"$expect"*) return 0 ;; esac

  # Teams truncates long group titles to "A, B, C, +N". When it does, only the
  # shown names can be verified — the remaining N are not in the title at all.
  # Verify every shown name appears in the expected participant list, and that
  # shown + N equals the expected participant count. That is still a strict
  # check (a different chat has different names or a different total), it just
  # does not demand the presence of names Teams has hidden.
  local hidden=0
  case "$t" in
    *", +"[0-9]*)
      hidden=$(printf '%s' "$t" | sed -n 's/.*, +\([0-9][0-9]*\).*/\1/p')
      ;;
  esac

  if [ -n "$hidden" ] && [ "$hidden" -gt 0 ] 2>/dev/null; then
    local shown_list shown_count=0 expect_count=0 name
    # The title is "Chat | A, B, C, +N | Microsoft Teams" — take the middle field.
    shown_list=$(printf '%s' "$t" | sed -n 's/^Chat | \(.*\), +[0-9][0-9]* | .*$/\1/p')
    ok=1
    while IFS= read -r name; do
      name="${name#"${name%%[![:space:]]*}"}"; name="${name%"${name##*[![:space:]]}"}"
      [ -n "$name" ] || continue
      shown_count=$((shown_count + 1))
      # Each shown name (first name or full) must appear in the expected list.
      case "$expect" in *"$name"*) ;; *) ok=0 ;; esac
    done < <(printf '%s\n' "$shown_list" | tr ',' '\n')
    while IFS= read -r name; do
      name="${name#"${name%%[![:space:]]*}"}"; name="${name%"${name##*[![:space:]]}"}"
      [ -n "$name" ] && expect_count=$((expect_count + 1))
    done < <(printf '%s\n' "$expect" | tr ',' '\n')
    # shown names + hidden count must account for exactly the expected roster.
    [ "$shown_count" -gt 0 ] || ok=0
    [ $((shown_count + hidden)) -eq "$expect_count" ] || ok=0
    if [ "$ok" -eq 1 ]; then
      return 0
    fi
    echo "ABORT: wrong conversation open." >&2
    echo "       expected: $expect" >&2
    echo "       actual window title: ${t:-<none>}" >&2
    echo "       (truncated title: matched $shown_count shown + $hidden hidden vs $expect_count expected)" >&2
    return 1
  fi

  # Split the expected name on ", " and check each non-self participant.
  ok=1
  local checked=0
  while IFS= read -r part; do
    part="${part#"${part%%[![:space:]]*}"}"   # ltrim
    part="${part%"${part##*[![:space:]]}"}"   # rtrim
    [ -n "$part" ] || continue
    [ "$part" = "$self" ] && continue
    checked=$((checked + 1))
    case "$t" in
      *"$part"*) ;;
      *) ok=0 ;;
    esac
  done < <(printf '%s\n' "$expect" | tr ',' '\n')
  # If every participant was self (nothing checked), that is not a match.
  [ "$checked" -gt 0 ] || ok=0

  if [ "$ok" -eq 1 ]; then
    return 0
  fi

  echo "ABORT: wrong conversation open." >&2
  echo "       expected: $expect" >&2
  echo "       actual window title: ${t:-<none>}" >&2
  return 1
}

# --- conversation resolution ---------------------------------------------

TEAMS_SKILL="${TEAMS_SKILL:-$HOME/.claude/skills/teams}"
TEAMS_PY="$TEAMS_SKILL/.venv/bin/python"
TEAMS_CLI="$TEAMS_SKILL/scripts/teams_cli.py"

# Resolve a channel/DM display name to its conversation id via the local cache.
# Exact (case-insensitive) match wins; otherwise the first substring match.
teams_resolve_conversation() {
  local want="$1"
  [ -x "$TEAMS_PY" ] || { echo "teams skill venv not found at $TEAMS_PY" >&2; return 1; }
  # Priority order matters. A bare substring match is dangerous: "Alex Example"
  # substring-matches a 6-person group chat that merely includes him, which would
  # post a private message to a group. So:
  #   1. exact name match
  #   2. 2-person DM containing the name  (the "message a person" case)
  #   3. substring match, but ONLY if exactly one conversation matches
  timeout 60s "$TEAMS_PY" "$TEAMS_CLI" channels --json 2>/dev/null \
    | jq -r --arg w "$want" '
        ( [ .data[] | select(.name != null)
            | select((.name|ascii_downcase) == ($w|ascii_downcase)) ] ) as $exact
        | ( [ .data[] | select(.name != null) | select(.members == 2)
              | select((.name|ascii_downcase) | contains($w|ascii_downcase)) ] ) as $dm
        | ( [ .data[] | select(.name != null)
              | select((.name|ascii_downcase) | contains($w|ascii_downcase)) ] ) as $sub
        | if   ($exact|length) > 0 then $exact[0].id
          elif ($dm|length)    == 1 then $dm[0].id
          elif ($sub|length)   == 1 then $sub[0].id
          else empty end'
}

# List every candidate for a name, so ambiguity can be shown to the user.
teams_resolve_candidates() {
  local want="$1"
  timeout 60s "$TEAMS_PY" "$TEAMS_CLI" channels --json 2>/dev/null \
    | jq -r --arg w "$want" '
        .data[] | select(.name != null)
        | select((.name|ascii_downcase) | contains($w|ascii_downcase))
        | "  - \(.name)   [\(.members // "?") members]"'
}

# Human-readable name for a conversation id (used for the title gate).
teams_conversation_name() {
  local id="$1"
  timeout 60s "$TEAMS_PY" "$TEAMS_CLI" channels --json 2>/dev/null \
    | jq -r --arg i "$id" '.data[] | select(.id==$i) | .name' | head -1
}

# Deep-link forms differ for threads vs 1:1 chats.
teams_deeplink_for() {
  local id="$1"
  case "$id" in
    *"@unq.gbl.spaces") printf 'msteams:/l/chat/%s/0' "$id" ;;
    *) printf 'msteams:/l/message/%s/0?context=%%7B%%22contextType%%22%%3A%%22chat%%22%%7D' "$id" ;;
  esac
}

# --- actions --------------------------------------------------------------

teams_open_conversation() {
  local id="$1"
  open "$(teams_deeplink_for "$id")"
  sleep "${TEAMS_NAV_SETTLE:-6}"
}

# Click into the compose box before typing. A deep link SOMETIMES leaves focus
# there, but not reliably (observed 2026-08-04: focus landed on the sidebar), so
# never assume it. The compose box is the full-width bar at the bottom of the
# message pane; its position is derived from the window frame rather than
# hardcoded, since Teams exposes no accessibility element for it.
teams_focus_compose() {
  local wx wy ww wh cx cy
  read -r wx wy ww wh < <(
    timeout 30s peekaboo see --app "$TEAMS_APP" --json 2>/dev/null \
      | jq -r '[ .. | objects | select(.id? == "elem_1") | .bounds ][0]
               | "\(.x) \(.y) \(.width) \(.height)"'
  )
  [ -n "${wx:-}" ] && [ "$wx" != "null" ] || return 1
  # Screenshot coords are window-relative, so add the window origin to get screen
  # coords. The compose box spans the message pane (right of the ~580px sidebar)
  # and sits ~54px above the window's bottom edge. Measured 2026-08-04 against a
  # 1708x1059 window: compose box centre ~ (1100, 1005) window-relative.
  cx=$(awk -v x="$wx" -v w="$ww" 'BEGIN{printf "%d", x + w*0.64}')
  cy=$(awk -v y="$wy" -v h="$wh" 'BEGIN{printf "%d", y + h - 54}')
  TEAMS_COMPOSE_XY="${cx},${cy}"
  # NOTE: check the click's exit status explicitly. Without this the function
  # returns the status of `sleep` (always 0) and a failed click reports success,
  # which is exactly how the "staged" message ended up never being pasted.
  # --app makes --coords WINDOW-relative. Screen coords need --global-coords.
  # Peekaboo silently exits 0 on this error, so check its stderr, not $?.
  local err
  err=$(timeout 25s peekaboo click --coords "${cx},${cy}" --app "$TEAMS_APP" \
          --global-coords --foreground --input-strategy synthOnly 2>&1)
  case "$err" in
    *Error*|*error*)
      echo "compose click failed at ${cx},${cy}: $err" >&2
      return 1
      ;;
  esac
  sleep 1
  return 0
}

# Put text on the clipboard and paste it into the compose box.
# Caller is responsible for having verified focus AND conversation first.
# Empty the compose box. Caller must have focused it already.
teams_clear_compose() {
  timeout 20s peekaboo hotkey "cmd,a" >/dev/null 2>&1
  sleep 0.4
  timeout 20s peekaboo press delete >/dev/null 2>&1
  sleep 0.4
}

teams_paste_text() {
  local text="$1" attempt
  # Retry once: the first click after a deep-link navigation can land while Teams
  # is still settling, and a second attempt on a settled window succeeds.
  for attempt in 1 2; do
    if teams_focus_compose; then
      # Clear first: re-running teams-send (e.g. with --send) would otherwise
      # append to whatever is already staged and send the text twice.
      teams_clear_compose
      printf '%s' "$text" | pbcopy
      if timeout 25s peekaboo paste >/dev/null 2>&1; then
        sleep 1
        return 0
      fi
      echo "paste failed (attempt $attempt)" >&2
    fi
    sleep 2
  done
  echo "could not place text in the compose box after 2 attempts" >&2
  return 1
}

teams_screenshot() {
  local path="$1"
  timeout 30s peekaboo image --app "$TEAMS_APP" --path "$path" >/dev/null 2>&1
  echo "$path"
}
