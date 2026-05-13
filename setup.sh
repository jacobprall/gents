#!/usr/bin/env bash
set -euo pipefail

# ─── Colors & helpers ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()    { printf "${BLUE}▸${RESET} %s\n" "$*"; }
success() { printf "${GREEN}✔${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
fail()    { printf "${RED}✖${RESET} %s\n" "$*"; exit 1; }
step()    { printf "\n${BOLD}── %s${RESET}\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENTS_CONFIG_DIR="$HOME/.gents"
GENTS_CONFIG_FILE="$GENTS_CONFIG_DIR/config.json"

# ─── 1. Check & install Bun ───────────────────────────────────────
step "Runtime: Bun"

if command -v bun &>/dev/null; then
  BUN_VER=$(bun --version 2>/dev/null || echo "unknown")
  success "Bun already installed (v$BUN_VER)"
else
  info "Bun not found — installing via bun.sh..."
  curl -fsSL https://bun.sh/install | bash

  # Source the updated PATH so bun is available in this session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command -v bun &>/dev/null; then
    success "Bun installed (v$(bun --version))"
  else
    fail "Bun installation failed. Install manually from https://bun.sh and re-run this script."
  fi
fi

# ─── 2. Check & install pnpm ─────────────────────────────────────
step "Package manager: pnpm"

if command -v pnpm &>/dev/null; then
  PNPM_VER=$(pnpm --version 2>/dev/null || echo "unknown")
  success "pnpm already installed (v$PNPM_VER)"
else
  info "pnpm not found — installing via corepack..."
  if command -v corepack &>/dev/null; then
    corepack enable
    corepack prepare pnpm@9.15.4 --activate
  else
    info "corepack unavailable, installing pnpm via npm..."
    npm install -g pnpm@9.15.4
  fi

  if command -v pnpm &>/dev/null; then
    success "pnpm installed (v$(pnpm --version))"
  else
    fail "pnpm installation failed. Install manually: npm install -g pnpm"
  fi
fi

# ─── 3. Check git ────────────────────────────────────────────────
step "Git"

if command -v git &>/dev/null; then
  GIT_VER=$(git --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
  success "git available (v$GIT_VER)"
else
  warn "git not found — git-based tools will be unavailable"
  warn "Install from https://git-scm.com/downloads"
fi

# ─── 4. Install dependencies ─────────────────────────────────────
step "Installing dependencies"

cd "$SCRIPT_DIR"
info "Running pnpm install..."
pnpm install
success "Dependencies installed (including @sqliteai/sqlite-sync)"

# ─── 5. Build the project ────────────────────────────────────────
step "Building project"

info "Running pnpm build..."
pnpm build
success "Build complete"

# ─── 6. Link the CLI ─────────────────────────────────────────────
step "Setting up CLI"

info "Linking gents CLI globally..."
cd "$SCRIPT_DIR/apps/cli"
bun link 2>/dev/null || true
bun link @gents/cli 2>/dev/null || true
cd "$SCRIPT_DIR"

# Verify the CLI is accessible, fall back to alias suggestion
if command -v gents &>/dev/null; then
  success "gents CLI linked globally"
else
  GENTS_BIN="$SCRIPT_DIR/apps/cli/src/index.ts"
  warn "Could not link globally. You can run the CLI directly:"
  info "  bun $GENTS_BIN"
  info ""
  info "Or add an alias to your shell profile:"
  info "  alias gents='bun $GENTS_BIN'"
fi

# ─── 7. Set up global config & prompt for API keys ───────────────
step "Configuration"

mkdir -p "$GENTS_CONFIG_DIR"

read_config_key() {
  local key="$1"
  if [ -f "$GENTS_CONFIG_FILE" ]; then
    # Use bun to parse JSON reliably
    bun -e "
      const fs = require('fs');
      try {
        const cfg = JSON.parse(fs.readFileSync('$GENTS_CONFIG_FILE', 'utf8'));
        if (cfg['$key']) process.stdout.write(String(cfg['$key']));
      } catch {}
    " 2>/dev/null || true
  fi
}

write_config_key() {
  local key="$1"
  local value="$2"
  if [ -f "$GENTS_CONFIG_FILE" ]; then
    bun -e "
      const fs = require('fs');
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync('$GENTS_CONFIG_FILE', 'utf8')); } catch {}
      cfg['$key'] = '$value';
      fs.writeFileSync('$GENTS_CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    " 2>/dev/null
  else
    bun -e "
      const fs = require('fs');
      const cfg = { '$key': '$value' };
      fs.writeFileSync('$GENTS_CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    " 2>/dev/null
  fi
}

mask_key() {
  local key="$1"
  local len=${#key}
  if [ "$len" -le 12 ]; then
    echo "${key:0:4}..."
  else
    echo "${key:0:8}...${key: -4}"
  fi
}

prompt_api_key() {
  local label="$1"
  local env_var="$2"
  local config_key="$3"

  # Check env first
  local env_val="${!env_var:-}"
  if [ -n "$env_val" ]; then
    success "$label API key found in environment ($(mask_key "$env_val"))"
    return 0
  fi

  # Check config
  local cfg_val
  cfg_val=$(read_config_key "$config_key")
  if [ -n "$cfg_val" ]; then
    success "$label API key found in config ($(mask_key "$cfg_val"))"
    return 0
  fi

  # Prompt user
  printf "${YELLOW}?${RESET} ${BOLD}$label API key${RESET} ${DIM}($env_var)${RESET}\n"
  printf "  Enter key or press Enter to skip: "
  read -r user_key

  if [ -n "$user_key" ]; then
    write_config_key "$config_key" "$user_key"
    success "$label API key saved to $GENTS_CONFIG_FILE"
    return 0
  else
    warn "$label API key skipped"
    return 1
  fi
}

info "Checking API keys..."
info "At least one provider key is required to use gents."
echo ""

ANY_KEY_FOUND=0
prompt_api_key "Anthropic" "ANTHROPIC_API_KEY" "anthropic_api_key" && ANY_KEY_FOUND=1
prompt_api_key "OpenAI"    "OPENAI_API_KEY"    "openai_api_key"    && ANY_KEY_FOUND=1
prompt_api_key "Google"    "GOOGLE_API_KEY"     "google_api_key"    && ANY_KEY_FOUND=1

echo ""
if [ "$ANY_KEY_FOUND" -eq 0 ]; then
  warn "No API keys configured. You'll need at least one to use gents."
  info "You can add one later with: gents config set anthropic_api_key <your-key>"
else
  success "API keys configured"
fi

# Lock down config file permissions
if [ -f "$GENTS_CONFIG_FILE" ]; then
  chmod 600 "$GENTS_CONFIG_FILE"
  success "Config permissions set to 600"
fi

# ─── 8. Set up default config values ─────────────────────────────
step "Default settings"

HAS_MODEL=$(read_config_key "model")
if [ -z "$HAS_MODEL" ]; then
  info "Default model: claude-sonnet-4-20250514"
  info "Override anytime with: gents config set model <model-name>"
fi

# ─── 9. Run doctor ───────────────────────────────────────────────
step "Running gents doctor"

GENTS_BIN="$SCRIPT_DIR/apps/cli/src/index.ts"
bun "$GENTS_BIN" doctor || true

# ─── Done ─────────────────────────────────────────────────────────
printf "\n${GREEN}${BOLD}Setup complete!${RESET}\n\n"
printf "  ${BOLD}Quick start:${RESET}\n"
printf "    ${DIM}$${RESET} gents chat \"Hello, world!\"\n"
printf "    ${DIM}$${RESET} gents doctor          ${DIM}# verify environment${RESET}\n"
printf "    ${DIM}$${RESET} gents config list     ${DIM}# view configuration${RESET}\n"
printf "\n"
