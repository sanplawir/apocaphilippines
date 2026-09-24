FROM node:22-alpine
WORKDIR /game
COPY dist ./dist
COPY scripts/room-server.mjs ./scripts/room-server.mjs
ENV PORT=4174
EXPOSE 4174
USER node
CMD ["node", "scripts/room-server.mjs"]
