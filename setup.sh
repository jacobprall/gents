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
success "Dependencies installed (including sqlite-vector, sqlite-ai, sqlite-sync)"

# ─── 5. Build the project ────────────────────────────────────────
step "Building project"

info "Running pnpm build..."
pnpm build
success "Build complete"

# ─── 6. Verify SQLite extensions ─────────────────────────────────
step "SQLite Extensions"

info "Verifying sqlite-vector and sqlite-ai native extensions..."

VECTOR_OK=0
AI_OK=0

VECTOR_PATH=$(bun -e "
  try {
    const { getExtensionPath } = require('@sqliteai/sqlite-vector');
    process.stdout.write(getExtensionPath());
  } catch(e) {
    process.stderr.write(e.message);
    process.exit(1);
  }
" 2>/dev/null) && VECTOR_OK=1

AI_PATH=$(bun -e "
  try {
    const { getExtensionPath } = require('@sqliteai/sqlite-ai');
    process.stdout.write(getExtensionPath());
  } catch(e) {
    process.stderr.write(e.message);
    process.exit(1);
  }
" 2>/dev/null) && AI_OK=1

if [ "$VECTOR_OK" -eq 1 ]; then
  success "sqlite-vector extension found ($VECTOR_PATH)"
else
  warn "sqlite-vector extension not found — vector search will be unavailable"
  warn "Try: pnpm install --force (in $SCRIPT_DIR)"
fi

if [ "$AI_OK" -eq 1 ]; then
  success "sqlite-ai extension found ($AI_PATH)"
else
  warn "sqlite-ai extension not found — local embeddings will be unavailable"
  warn "Try: pnpm install --force (in $SCRIPT_DIR)"
fi

if [ "$VECTOR_OK" -eq 0 ] && [ "$AI_OK" -eq 0 ]; then
  warn "No SQLite extensions loaded — semantic search features will be fully unavailable"
fi

# ─── 7. Download embedding model ─────────────────────────────────
step "Embedding Model"

NOMIC_MODEL_DIR="$GENTS_CONFIG_DIR/models"
NOMIC_MODEL_FILE="nomic-embed-text-v1.5.Q8_0.gguf"
NOMIC_MODEL_PATH="$NOMIC_MODEL_DIR/$NOMIC_MODEL_FILE"
NOMIC_MODEL_URL="https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/$NOMIC_MODEL_FILE"

if [ -f "$NOMIC_MODEL_PATH" ]; then
  MODEL_SIZE=$(du -h "$NOMIC_MODEL_PATH" | cut -f1 | xargs)
  success "Nomic Embed v1.5 already downloaded ($MODEL_SIZE at $NOMIC_MODEL_PATH)"
else
  info "Nomic Embed Text v1.5 (Q8_0, ~146 MB) is required for local code embeddings."
  printf "  ${YELLOW}?${RESET} Download now? [Y/n] "
  read -r DOWNLOAD_CONFIRM

  if [ -z "$DOWNLOAD_CONFIRM" ] || [ "$DOWNLOAD_CONFIRM" = "y" ] || [ "$DOWNLOAD_CONFIRM" = "Y" ]; then
    mkdir -p "$NOMIC_MODEL_DIR"
    info "Downloading from Hugging Face..."
    if curl -fL --progress-bar -o "$NOMIC_MODEL_PATH.tmp" "$NOMIC_MODEL_URL"; then
      mv "$NOMIC_MODEL_PATH.tmp" "$NOMIC_MODEL_PATH"
      MODEL_SIZE=$(du -h "$NOMIC_MODEL_PATH" | cut -f1 | xargs)
      success "Nomic Embed v1.5 downloaded ($MODEL_SIZE)"
    else
      rm -f "$NOMIC_MODEL_PATH.tmp"
      warn "Download failed. You can retry later with:"
      info "  curl -fL -o '$NOMIC_MODEL_PATH' '$NOMIC_MODEL_URL'"
    fi
  else
    warn "Embedding model download skipped. Local code search will be unavailable."
    info "Download later with:"
    info "  mkdir -p '$NOMIC_MODEL_DIR'"
    info "  curl -fL -o '$NOMIC_MODEL_PATH' '$NOMIC_MODEL_URL'"
  fi
fi

# ─── 8. Link the CLI ─────────────────────────────────────────────
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

# ─── 9. Set up global config & prompt for API keys ───────────────
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

# ─── 10. Set up default config values ────────────────────────────
step "Default settings"

HAS_MODEL=$(read_config_key "model")
if [ -z "$HAS_MODEL" ]; then
  info "Default model: claude-sonnet-4-20250514"
  info "Override anytime with: gents config set model <model-name>"
fi

# ─── 11. Run doctor ──────────────────────────────────────────────
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
