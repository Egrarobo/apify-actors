# Playwright + Chrome image: the ALDI API is read with plain HTTP; a real browser is only the fallback when requests
# are blocked (optional cookie bootstrap / in-browser requests).
FROM apify/actor-node-playwright-chrome:22
COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional --no-audit \
 && echo "Installed NPM packages:" && (npm list --omit=dev --all || true) \
 && (npx playwright install chromium || echo "Browser download skipped; the Actor falls back to the image's Chrome.")
COPY --chown=myuser . ./
# Virtual display so the fallback browser can run headful (headless Chrome is refused by bot protection far more often).
CMD ./start_xvfb_and_run_cmd.sh && npm start --silent
