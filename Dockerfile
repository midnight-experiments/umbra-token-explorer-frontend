# The token explorer: Node's standard library only, so the image is the runtime plus the page and the server.
FROM node:24-alpine

WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10591
EXPOSE 10591
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/main.mjs"]
