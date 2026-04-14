#!/bin/bash
# Expose the MAS-Orchestra demo (already running on localhost:3000) via cloudflared.
# Usage: bash serve.sh

cloudflared tunnel --url http://localhost:3000
# https://playstation-acid-dose-nascar.trycloudflare.com

