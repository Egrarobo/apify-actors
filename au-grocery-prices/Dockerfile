# Playwright + Chrome image: a real browser is needed to pass Coles' bot protection (and as a fallback for Woolworths).
FROM apify/actor-node-playwright-chrome:22
COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional --no-audit \
 && echo "Installed NPM packages:" && (npm list --omit=dev --all || true) \
 && (npx playwright install chromium || echo "Browser download skipped; the Actor falls back to the image's Chrome.")
COPY --chown=myuser . ./
# Start a virtual display so the browser can run headful (headless Chrome is refused by Akamai/Imperva far more often).
CMD ./start_xvfb_and_run_cmd.sh && npm start --silent
