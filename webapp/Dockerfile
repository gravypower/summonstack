FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install

# Maintenance scripts in scripts/ run outside the Next.js bundle, so they
# cannot use its bundled mysql2 and the standalone output does not trace it.
# The version is read from package.json so the two cannot drift apart.
# package.json is staged outside the workdir so npm installs mysql2 alone
# rather than resolving the whole app dependency tree.
FROM node:22-alpine AS script-deps
WORKDIR /deps
COPY package.json /tmp/app-package.json
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-package-lock --no-save \
      "mysql2@$(node -p "require('/tmp/app-package.json').dependencies.mysql2")"

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,target=/app/.next/cache npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
# Shop pack definitions, read by scripts/seed-shop.mjs at seed time.
COPY --from=build /app/data ./data
# Resolved ahead of /app/node_modules for anything under scripts/, so this
# leaves the traced standalone modules untouched.
COPY --from=script-deps /deps/node_modules ./scripts/node_modules
EXPOSE 3000
CMD ["node", "server.js"]
