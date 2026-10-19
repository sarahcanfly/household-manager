#!/bin/sh
# Netlify build step: point this copy of the app at its own family's database.
# Each family's Netlify site sets HM_SUPABASE_URL and HM_SUPABASE_KEY (Site configuration →
# Environment variables). Without them, the committed web/config.js is used, which is only
# allowed for the original site, so a new family's site can never point at someone else's data.
set -e
cd "$(dirname "$0")/.."
ORIGINAL_SITE="mikeysarah"
if [ -n "$HM_SUPABASE_URL" ] && [ -n "$HM_SUPABASE_KEY" ]; then
  case "$HM_SUPABASE_URL" in https://*.supabase.co) ;; *) echo "HM_SUPABASE_URL must look like https://<ref>.supabase.co"; exit 1;; esac
  case "$HM_SUPABASE_KEY" in *[!A-Za-z0-9_.-]*) echo "HM_SUPABASE_KEY has unexpected characters"; exit 1;; esac
  printf "window.HM_CONFIG = {\n  supabaseUrl: '%s',\n  supabaseAnonKey: '%s',\n};\n" "$HM_SUPABASE_URL" "$HM_SUPABASE_KEY" > web/config.js
  echo "config.js points at $HM_SUPABASE_URL"
elif [ -n "$SITE_NAME" ] && [ "$SITE_NAME" != "$ORIGINAL_SITE" ]; then
  echo "This site ($SITE_NAME) has no HM_SUPABASE_URL / HM_SUPABASE_KEY. Add them under Site configuration → Environment variables."
  exit 1
else
  echo "Using the committed web/config.js"
fi
