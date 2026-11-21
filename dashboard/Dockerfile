FROM node:24-alpine

WORKDIR /app
COPY dashboard/server.mjs dashboard/schema.sql ./
RUN mkdir /data && chown node:node /data

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
