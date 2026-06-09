FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3210

ENV NODE_ENV=production
ENV HARNESS_PORT=3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http = require('http'); const req = http.get('http://localhost:3210/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1)); req.setTimeout(3000, () => { req.destroy(); process.exit(1); });"

ENTRYPOINT ["node", "harness-cli.js"]
CMD ["dashboard", "--host", "0.0.0.0"]
