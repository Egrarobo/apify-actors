# Playwright + Chrome image: most portals work over plain HTTP, but a real browser is the fallback when a portal
# blocks plain requests (Cloudflare/WAF) or needs JavaScript.
FROM apify/actor-node-playwright-chrome:22
COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional --no-audit \
 && echo "Installed NPM packages:" && (npm list --omit=dev --all || true) \
 && (npx playwright install chromium || echo "Browser download skipped; the Actor falls back to the image's Chrome.")
COPY --chown=myuser . ./
# Virtual display so the browser fallback can run headful (fewer bot-check refusals than headless).
CMD ./start_xvfb_and_run_cmd.sh && npm start --silent
