FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY scripts/user.js ./scripts/user.js
COPY public ./public
# Map geometry ships with the image; database + session key live in the volume.
COPY data/*.geojson ./geo/
ENV DATA_DIR=/data GEO_DIR=/app/geo PORT=8080 NODE_NO_WARNINGS=1
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
