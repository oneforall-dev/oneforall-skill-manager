FROM node:24-bookworm-slim
WORKDIR /app
ARG PUBLISHER_BUNDLE_URL
ADD ${PUBLISHER_BUNDLE_URL} /tmp/publisher.tgz
RUN tar -xzf /tmp/publisher.tgz --strip-components=1 && rm /tmp/publisher.tgz
RUN npm install --omit=dev
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:8787/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["sh","-c","npm run migrate && node dist/server.js"]

