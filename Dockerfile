FROM node:22-alpine

WORKDIR /app

# Zero external dependencies needed
COPY . .

ENV PORT=3000
ENV NODE_ENV=development

EXPOSE 3000

CMD ["node", "server/src/index.js"]
