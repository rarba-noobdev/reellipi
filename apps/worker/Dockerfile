# ReelLipi render worker.
#
# ffmpeg must be built with libass, and the Noto families have to be present in the
# image: Debian slim ships no Indic fonts, and libass renders a missing glyph as a
# tofu box rather than failing, so a missing font is a silent visual bug.

FROM node:20-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fontconfig \
      libass9 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------------------------------------------------------- deps
FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --omit=dev --workspace @reellipi/worker --include-workspace-root \
    || npm install --omit=dev --workspace @reellipi/worker --include-workspace-root

# ---------------------------------------------------------------- build
FROM base AS build
COPY package.json package-lock.json* ./
COPY apps/worker/package.json apps/worker/package.json
RUN npm install --workspace @reellipi/worker --include-workspace-root
COPY apps/worker apps/worker
RUN npm run build --workspace @reellipi/worker

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
ENV FFMPEG_PATH=ffmpeg
ENV FFPROBE_PATH=ffprobe

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/apps/worker/dist /app/apps/worker/dist
COPY apps/worker/package.json /app/apps/worker/package.json
COPY apps/worker/fonts /app/apps/worker/fonts

# Register the bundled fonts with fontconfig so libass resolves them by family name.
RUN mkdir -p /usr/share/fonts/truetype/noto-reellipi \
    && cp /app/apps/worker/fonts/*.ttf /usr/share/fonts/truetype/noto-reellipi/ \
    && fc-cache -f

WORKDIR /app/apps/worker

# Fail the build if ffmpeg lacks libass or the Indic fonts did not land.
RUN ffmpeg -hide_banner -version | grep -q -- '--enable-libass' \
      && echo "libass: OK" \
    && fc-list | grep -qi 'Noto Sans Tamil' && echo "Noto Tamil: OK" \
    && fc-list | grep -qi 'Noto Sans Devanagari' && echo "Noto Devanagari: OK"

EXPOSE 8787
CMD ["node", "dist/index.js"]
