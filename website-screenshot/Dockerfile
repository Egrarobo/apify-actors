FROM apify/actor-node-playwright-chrome:22
COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional --no-audit \
 && echo "Installed NPM packages:" && (npm list --omit=dev --all || true)
COPY --chown=myuser . ./
CMD npm start --silent
